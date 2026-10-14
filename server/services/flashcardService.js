// Flashcards: source-grounded front/back pairs generated from retrieved passages.

import { chatCompletion } from './nimChat.js';
import { retrieve, toCitation, hitScore } from './retrieval.js';
import { wrapPassages, UNTRUSTED_RULE } from './prompts.js';
import { parseJsonLoose } from './quizService.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { newId, nowIso } from '../store/sqlite.js';

const MAX_ATTEMPTS = 2;

export function normalizeCard(raw, hits) {
  if (!raw || typeof raw !== 'object') return null;
  const front = typeof raw.front === 'string' ? raw.front.trim() : '';
  const back = typeof raw.back === 'string' ? raw.back.trim() : '';
  if (front.length < 5 || front.length > 250) return null;
  if (back.length < 10 || back.length > 700) return null;

  const cite = Array.isArray(raw.cite) ? raw.cite.filter((n) => Number.isInteger(n) && n >= 1) : [];
  const citations = cite.map((n) => hits[n - 1]).filter(Boolean).slice(0, 3).map(toCitation);
  if (citations.length === 0) citations.push(...hits.slice(0, 1).map(toCitation));

  return { front, back, citations };
}

export async function generateFlashcards({ topic, count = 8, sourceIds = [], sessionId = null, userId = 'default' }, { ai, vector, db } = {}) {
  const chat = ai?.chatCompletion ?? chatCompletion;
  const hits = await retrieve(topic, { sourceIds, k: 8, minScore: 0, ai, vector, userId });
  const weakEvidence = hits.every((hit) => (hitScore(hit) ?? 0) < config.ragMinSimilarity);

  if (hits.length === 0) {
    throw new ApiError(422, 'QUIZ_CONTENT_INVALID',
      'Not enough indexed material on this topic yet. Upload relevant material or pick another topic.');
  }

  const evidence = wrapPassages(hits);
  const systemPrompt = [
    'You create study flashcards strictly from the passages provided.',
    UNTRUSTED_RULE,
    `Topic: ${topic}.`,
    'Return ONLY JSON, no other text: {"cards":[{"front":"question or concept","back":"concise answer or explanation","cite":[1,2]}]}',
    '"front" is what the student sees first; "back" reveals the answer. "cite" lists supporting passage numbers (1-based).',
  ].join('\n');

  const cards = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS && cards.length < count; attempt++) {
    const content = await chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Passages:\n\n${evidence}\n\nWrite ${count} flashcards.` },
    ], { model: config.nimAssessModel, maxTokens: 2500 });

    const parsed = parseJsonLoose(content);
    for (const raw of parsed?.cards ?? []) {
      if (cards.length >= count) break;
      const card = normalizeCard(raw, hits);
      if (card && !cards.some((c) => c.front.toLowerCase() === card.front.toLowerCase())) cards.push(card);
    }
  }

  if (cards.length === 0) {
    throw new ApiError(422, 'QUIZ_CONTENT_INVALID',
      'The model could not produce valid flashcards from this material. Try another topic or add more material.');
  }

  const result = {
    topic,
    model: config.nimAssessModel,
    cards: cards.map((card, i) => ({ id: `card_${i + 1}`, ...card })),
  };

  // Persisted: flashcards become browseable study resources, not one-shot responses.
  let deckId = null;
  if (db) {
    deckId = newId('deck');
    await db.batch([
      {
        sql: 'INSERT INTO decks (id, user_id, session_id, topic, source_ids_json, card_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [deckId, userId, sessionId, topic, JSON.stringify(sourceIds), cards.length, nowIso()],
      },
      ...result.cards.map((card, idx) => ({
        sql: 'INSERT INTO deck_cards (deck_id, idx, front, back, citations_json) VALUES (?, ?, ?, ?, ?)',
        args: [deckId, idx, card.front, card.back, JSON.stringify(card.citations)],
      })),
    ], 'write');
  }
  return { topic, model: config.nimAssessModel, cards: result.cards, ...(weakEvidence ? { weakEvidence: true } : {}), deckId, sessionId };
}
