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

// The source with this id for this user, or a 404. Another user's source id is
// exactly "does not exist", so the lookup and the error live in one place.
async function loadOwnedSource(db, sourceId, userId) {
  const source = await db.get('SELECT * FROM sources WHERE id = ? AND user_id = ?', sourceId, userId);
  if (!source) throw new ApiError(404, 'SOURCE_NOT_FOUND', `Source "${sourceId}" does not exist.`);
  return source;
}

// A model-proposed new session, or null when it breaks the strict schema
// (unknown category, title not 2–80 chars, subject over 120 chars). Numeric-only
// tags ("42") are junk and dropped; an empty result falls back to "misc".
function readNewSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = CATEGORIES.has(raw.category) ? raw.category : null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  if (!category || title.length < 2 || title.length > 80 || subject.length > 120) return null;

  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6)
    .filter((tag) => /[a-z]/i.test(tag)) // drop numeric junk like "42"
    .slice(0, 5);
  return { category, title, subject, tags: tags.length > 0 ? tags : ['misc'] };
}

export function normalizeSuggestion(raw, sessions) {
  if (!raw || typeof raw !== 'object') return null;
  const known = new Map(sessions.map((s) => [s.id, s]));
  const matchSessionId = typeof raw.matchSessionId === 'string' && known.has(raw.matchSessionId)
    ? raw.matchSessionId
    : null;
  const newSession = readNewSession(raw.newSession);

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
    const duplicate = sessions.find(
      (s) => s.status === 'active' && s.title.trim().toLowerCase() === newSession.title.toLowerCase(),
    );
    if (duplicate) return normalizeSuggestion({ ...raw, matchSessionId: duplicate.id, newSession: null }, sessions);
  }

  return { matchSessionId, newSession, confidence, reason };
}

export async function suggestOrganization(db, { sourceId, description, userId = 'default' }, { chat } = {}) {
  const chatFn = chat ?? chatCompletion;
  const source = await loadOwnedSource(db, sourceId, userId);

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
      // Assessment-grade model: the chat model (lightning) repeatedly returned
      // empty content live on this classification prompt; the super-120b model
      // has been reliable at producing strict JSON all through the project.
      const content = await chatFn([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
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

// The session a stored suggestion points at: the matched one when it still
// exists, else the proposed new session — reusing an active duplicate created
// since the suggestion was stored. User-scoped throughout.
async function resolveTargetSession(db, stored, userId) {
  if (stored.matchSessionId) return stored.matchSessionId;

  const duplicate = await db.get(
    "SELECT id FROM study_sessions WHERE status = 'active' AND lower(trim(title)) = lower(?) AND user_id = ?",
    stored.newSession.title, userId,
  );
  if (duplicate) return duplicate.id;

  const sessionId = newId('ses');
  const now = nowIso();
  await db.run(`INSERT INTO study_sessions (id, user_id, title, category, description, tags_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  sessionId, userId, stored.newSession.title, stored.newSession.category, stored.newSession.subject || null, JSON.stringify(stored.newSession.tags), now, now);
  return sessionId;
}

export async function acceptOrganization(db, { sourceId, userId = 'default' }) {
  const source = await loadOwnedSource(db, sourceId, userId);

  let stored = null;
  try { stored = JSON.parse(source.suggestion_json || 'null'); } catch { stored = null; }
  if (!stored || (!stored.matchSessionId && !stored.newSession)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Ask for an organisation suggestion first, then accept it.');
  }

  const sessionId = await resolveTargetSession(db, stored, userId);

  // Accepting is an explicit user action → counts as a manual choice, so later
  // suggestions are shown as "applicable: false" until the user acts again.
  await db.run("UPDATE sources SET session_id = ?, org_source = 'ai', manual_override = 1 WHERE id = ? AND user_id = ?", sessionId, sourceId, userId);
  const updated = await db.get('SELECT * FROM sources WHERE id = ? AND user_id = ?', sourceId, userId);
  const session = sessionId ? await db.get('SELECT * FROM study_sessions WHERE id = ? AND user_id = ?', sessionId, userId) : null;
  await logActivity(db, 'organize', null, `${source.title} suggested → ${session?.title ?? 'Unsorted'}`, sessionId, userId);

  return { source: updated, session };
}
