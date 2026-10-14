// POST /api/extension/relevance — which sentences on a page relate to THIS
//                                user's study documents (the highlighter).
// POST /api/extension/briefing  — a grounded briefing for one page passage
//                                 (the floating panel; the tutor without a
//                                 session).
//
// Both are per-user: requireAuth sets req.userId and every vector query is
// scoped to it, so one student's page can never highlight or cite another
// student's material. The extension sends `Authorization: Bearer <jwt>`.

import express from 'express';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { answerQuestion } from '../services/tutorService.js';
import { hitScore, toCitation, validateSourceIds } from '../services/retrieval.js';
import { logActivity } from '../store/sqlite.js';

// Mirrors the extension's own limits (highlight.js / panel.js): the client
// enforces them for UX, the server re-checks because the client is untrusted.
const MAX_BLOCKS = 60;
const MAX_BLOCK_CHARS = 600;
const MIN_BRIEFING_CHARS = 60;
const MAX_BRIEFING_CHARS = 1500;

function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > MAX_BLOCKS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `blocks must be an array of 1 to ${MAX_BLOCKS} items.`);
  }
  for (const block of blocks) {
    if (!block || typeof block.id !== 'string' || block.id.length < 1 || block.id.length > 64) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Every block needs a string id of 1 to 64 characters.');
    }
    if (typeof block.text !== 'string' || block.text.trim().length < 1 || block.text.length > MAX_BLOCK_CHARS) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Every block needs 1 to ${MAX_BLOCK_CHARS} characters of text.`);
    }
  }
}

export function extensionRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  // POST /api/extension/relevance — { blocks: [{ id, text }] } →
  //   { matches: [{ id, score, citation }], minScore }
  router.post('/relevance', async (req, res) => {
    const { blocks } = req.body ?? {};
    validateBlocks(blocks);
    const userId = req.userId;

    // No material yet → nothing on any page can relate to it. Skip the paid
    // embedding call entirely (this endpoint runs on every page visit).
    const owned = await db.get('SELECT COUNT(*) AS n FROM sources WHERE user_id = ?', userId);
    if (owned.n === 0) {
      return res.json({ matches: [], minScore: config.extensionMinSimilarity });
    }

    const embeddings = await ai.embedTexts(blocks.map((block) => block.text.trim()));

    // Nearest OWN chunk per sentence. Batch when the store supports it
    // (one HTTP round-trip for Chroma), otherwise fall back per embedding.
    let tops;
    if (typeof vector.queryChunksBatch === 'function') {
      tops = await vector.queryChunksBatch({ embeddings, nResults: 1, userId });
    } else {
      tops = await Promise.all(
        embeddings.map((embedding) => vector.queryChunks({ embedding, nResults: 1, userId })),
      );
    }

    const matches = [];
    blocks.forEach((block, i) => {
      const hit = tops[i]?.[0];
      if (!hit) return;
      const score = hitScore(hit);
      if (score === undefined || score < config.extensionMinSimilarity) return;
      matches.push({ id: block.id, score, citation: toCitation(hit) });
    });
    res.json({ matches, minScore: config.extensionMinSimilarity });
  });

  // POST /api/extension/briefing — { text, sourceIds? } →
  //   { answer, citations, needsContent, suggestions, model } (exactly what
  //   panel.js renders)
  router.post('/briefing', async (req, res) => {
    const { text, sourceIds } = req.body ?? {};
    if (typeof text !== 'string' || text.trim().length < MIN_BRIEFING_CHARS || text.trim().length > MAX_BRIEFING_CHARS) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Briefing text must be between ${MIN_BRIEFING_CHARS} and ${MAX_BRIEFING_CHARS} characters.`);
    }
    if (sourceIds !== undefined) validateSourceIds(sourceIds);

    const userId = req.userId;
    const asked = text.trim();
    // Same answering core as /api/tutor/ask: user-scoped retrieval, v1.4
    // personalisation, honest abstain when the passages do not cover it.
    const result = await answerQuestion(
      { question: asked, sourceIds: sourceIds ?? [], db, userId },
      { ai, vector },
    );
    await logActivity(db, 'question', null, `Asked: ${asked.slice(0, 80)}`, null, userId);
    // Whitelisted fields only — never raw tutor internals. When the tutor
    // abstains, `suggestions` carries 0–4 real topic strings from the user's
    // own material; a tutor result without the field (older build) yields [].
    const suggestions = Array.isArray(result.suggestions)
      ? result.suggestions
          .filter((topic) => typeof topic === 'string' && topic.trim().length > 0)
          .map((topic) => topic.trim())
          .slice(0, 4)
      : [];
    res.json({
      answer: result.answer,
      citations: result.citations,
      needsContent: result.needsContent,
      suggestions,
      model: result.model,
    });
  });

  return router;
}
