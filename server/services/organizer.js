// AI-assisted source organisation. The model receives the material's metadata
// plus a short text sample and the user's existing sessions, and ANSWERS with a
// suggestion — it never touches records. Everything it returns is validated
// here before being stored or applied, and ingestion can never fail because of
// this feature (it runs in its own endpoint, after the upload succeeded).

import { chatCompletion } from './nimChat.js';
import { parseJsonLoose } from './quizService.js';
import { UNTRUSTED_RULE } from './prompts.js';
import { CATEGORIES } from '../constants.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { newId, nowIso, logActivity } from '../store/sqlite.js';

const MAX_ATTEMPTS = 2; // bounded retries when the model returns unusable JSON
const TEXT_SAMPLE_CHARS = 1200;
const MAX_SESSIONS_LISTED = 30;

// ---------- pure validation (exported for tests) ----------

export function normalizeSuggestion(raw, sessions) {
  if (!raw || typeof raw !== 'object') return null;
  const known = new Map(sessions.map((s) => [s.id, s]));
  const matchSessionId = typeof raw.matchSessionId === 'string' && known.has(raw.matchSessionId)
    ? raw.matchSessionId
    : null;

  let newSession = null;
  if (raw.newSession && typeof raw.newSession === 'object') {
    const category = CATEGORIES.has(raw.newSession.category) ? raw.newSession.category : null;
    const title = typeof raw.newSession.title === 'string' ? raw.newSession.title.trim() : '';
    const subject = typeof raw.newSession.subject === 'string' ? raw.newSession.subject.trim() : '';
    const tags = Array.isArray(raw.newSession.tags)
      ? raw.newSession.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 6)
      : [];
    if (category && title.length >= 2 && title.length <= 80 && subject.length <= 120) {
      newSession = { category, title, subject, tags };
    }
  }

  // Exactly one of the two branches must be present — strict schema: both or
  // neither is invalid model output and gets retried.
  if (matchSessionId !== null && newSession !== null) return null;
  if (matchSessionId === null && newSession === null) return null;

  const confidence = raw.confidence === 'high' ? 'high' : 'low';
  const reason = typeof raw.reason === 'string' && raw.reason.trim() !== ''
    ? raw.reason.trim().slice(0, 200)
    : '';

  // Server-side duplicate guard: if the proposed new session's title matches an
  // existing active session (case-insensitive), point at that session instead.
  if (newSession) {
    const tags = newSession.tags.filter((tag) => /[a-z]/i.test(tag)).slice(0, 5); // drop numeric junk like "42"
    newSession.tags = tags.length > 0 ? tags : ['misc'];
    const duplicate = sessions.find(
      (s) => s.status === 'active' && s.title.trim().toLowerCase() === newSession.title.toLowerCase(),
    );
    if (duplicate) return normalizeSuggestion({ ...raw, matchSessionId: duplicate.id, newSession: null }, sessions);
  }

  return { matchSessionId, newSession, confidence, reason };
}

export async function suggestOrganization(db, { sourceId, description, userId = 'default' }, { chat } = {}) {
  const chatFn = chat ?? chatCompletion;
  // Ownership: another user's source id here is exactly "does not exist".
  const source = await db.get('SELECT * FROM sources WHERE id = ? AND user_id = ?', sourceId, userId);
  if (!source) throw new ApiError(404, 'SOURCE_NOT_FOUND', `Source "${sourceId}" does not exist.`);

  const sample = (await db.all('SELECT text FROM source_segments WHERE source_id = ? ORDER BY seg_index LIMIT 3', sourceId))
    .map((row) => row.text)
    .join('\n')
    .slice(0, TEXT_SAMPLE_CHARS);

  const sessions = (await db.all('SELECT id, title, category, status FROM study_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?', userId, MAX_SESSIONS_LISTED));

  const systemPrompt = [
    'You organise study material into the student\'s existing study sessions.',
    UNTRUSTED_RULE,
    'Return ONLY JSON with exactly this shape:',
    '{"matchSessionId": "ses_id_from_the_list" | null, "newSession": {"category": "subject|research|self-study|exam-prep|general", "title": "2-80 chars", "subject": "one phrase", "tags": ["1","2"]} | null, "confidence": "high" | "low", "reason": "one short sentence"}',
    'Rules: exactly one of matchSessionId / newSession is non-null. Prefer the best-fitting EXISTING session; propose a new one only when nothing fits. Judge by CONTENT (a .pdf can be a research paper, a URL can be a lecture). Never invent ids.',
  ].join('\n');

  const userPrompt = [
    `Material title: ${source.title}`,
    `Type: ${source.type}`,
    source.url ? `URL: ${source.url}` : null,
    description ? `Student description: ${description}` : null,
    sample
      ? `Text sample (untrusted study content):\n<passage id="1">\n${sample}\n</passage>`
      : 'Text sample: (none extracted)',
    `Existing sessions: ${JSON.stringify(sessions.map(({ id, title, category }) => ({ id, title, category })))}`,
  ].filter(Boolean).join('\n');

  let suggestion = null;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !suggestion; attempt++) {
      const content = await chatFn([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      // Assessment-grade model: the chat model (lightning) repeatedly returned
      // empty content live on this classification prompt; the super-120b model
      // has been reliable at producing strict JSON all through the project.
      ], { model: config.nimAssessModel, maxTokens: 1200 });
      suggestion = normalizeSuggestion(parseJsonLoose(content), sessions);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('[organizer] model call failed:', err?.message ?? err);
    throw new ApiError(502, 'NIM_ERROR', 'The organiser could not talk to the AI model. You can organise this source manually.');
  }

  if (!suggestion) {
    throw new ApiError(502, 'NIM_ERROR', 'The organiser could not classify this source. You can organise it manually.');
  }

  const applicable = !source.manual_override;
  const record = { ...suggestion, savedAt: nowIso() };
  await db.run('UPDATE sources SET suggestion_json = ? WHERE id = ?', JSON.stringify(record), sourceId);

  return {
    sourceId: source.id,
    applicable,
    suggestion,
  };
}

export async function acceptOrganization(db, { sourceId, userId = 'default' }) {
  const source = await db.get('SELECT * FROM sources WHERE id = ? AND user_id = ?', sourceId, userId);
  if (!source) throw new ApiError(404, 'SOURCE_NOT_FOUND', `Source "${sourceId}" does not exist.`);

  let stored = null;
  try { stored = JSON.parse(source.suggestion_json || 'null'); } catch { stored = null; }
  if (!stored || (!stored.matchSessionId && !stored.newSession)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Ask for an organisation suggestion first, then accept it.');
  }

  let sessionId = null;
  if (stored.matchSessionId) {
    sessionId = stored.matchSessionId;
  } else {
    // Re-run the duplicate guard: something may have been created since.
    const duplicate = await db.get("SELECT id FROM study_sessions WHERE status = 'active' AND lower(trim(title)) = lower(?) AND user_id = ?", stored.newSession.title, userId);
    if (duplicate) {
      sessionId = duplicate.id;
    } else {
      sessionId = newId('ses');
      const now = nowIso();
      await db.run(`INSERT INTO study_sessions (id, user_id, title, category, description, tags_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        sessionId, userId, stored.newSession.title, stored.newSession.category, stored.newSession.subject || null, JSON.stringify(stored.newSession.tags), now, now);
    }
  }

  // Accepting is an explicit user action → counts as a manual choice, so later
  // suggestions are shown as "applicable: false" until the user acts again.
  await db.run("UPDATE sources SET session_id = ?, org_source = 'ai', manual_override = 1 WHERE id = ? AND user_id = ?", sessionId, sourceId, userId);
  const updated = await db.get('SELECT * FROM sources WHERE id = ? AND user_id = ?', sourceId, userId);
  const session = sessionId ? await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', sessionId, userId) : null;
  await logActivity(db, 'organize', null, `${source.title} suggested → ${session?.title ?? 'Unsorted'}`, sessionId, userId);

  return { source: updated, session };
}
