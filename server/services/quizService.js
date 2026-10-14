// Assessment: generate source-grounded MCQs from the student's OWN material,
// tag every question with a difficulty level 1-4, keep the answer key
// server-side, and let the deterministic learner model update afterwards.
//
// Determinism boundary (AGENTS.md): GENERATION is a model call, SCORING is not.
// Grading lives in server/services/grading.js (A18) and is re-exported here so
// the quiz routes and the tests keep a single import site. Nothing in the
// scoring path ever asks a model "is this right?" — it compares strings.

import { chatCompletion } from './nimChat.js';
import { retrieve, toCitation, hitScore } from './retrieval.js';
import { wrapPassages, UNTRUSTED_RULE } from './prompts.js';
import { isRepeatedQuestion } from './events.js';
import { LEVELS } from './learner.js';
import { CHOICE_IDS, gradeAnswers } from './grading.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { newId, nowIso } from '../store/sqlite.js';

// Scoring is A18's module (the single source of truth), but every caller has
// always imported it from here — tests/grading.test.js pins that import site.
export { gradeAnswers };

const MAX_ATTEMPTS = 2; // bounded retries when the model returns unusable JSON

// ---------- retrieving the material to assess over ----------

// The 422 both persisting generators show when retrieval found nothing.
const NOT_ENOUGH_MATERIAL = 'Not enough indexed material on this topic yet. Upload relevant material or pick another topic.';

/** Breadth retrieval for assessment generation: the SAME floor, flag and
 *  passage wrapping for every generator (quizzes, flashcards, practice
 *  questions), so they can never disagree about what "enough material" means.
 *  The floor is NOT applied to the search (a short topic query scores lower
 *  than a full question — contract v1.2); `weakEvidence` records that EVERY hit
 *  came back below it so the caller can warn honestly. */
export async function retrieveForAssessment(query, { sourceIds = [], ai, vector, userId = 'default' }) {
  const hits = await retrieve(query, { sourceIds, k: 8, minScore: 0, ai, vector, userId });
  return {
    hits,
    weakEvidence: hits.every((hit) => (hitScore(hit) ?? 0) < config.ragMinSimilarity),
    evidence: wrapPassages(hits),
  };
}

/** The 422 the two persisting generators raise when retrieval found nothing. */
export function requireMaterial(hits) {
  if (hits.length === 0) throw new ApiError(422, 'QUIZ_CONTENT_INVALID', NOT_ENOUGH_MATERIAL);
}

// ---------- pure helpers (exported for tests) ----------

export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Passage numbers a model may reference: 1-based positive integers only.
 * Anything else is dropped here and simply resolves to no hit at citation time.
 */
export function passageNumbers(cite) {
  return Array.isArray(cite) ? cite.filter((n) => Number.isInteger(n) && n >= 1) : [];
}

// ---------- difficulty tagging, level 1-4 (deterministic fallback) ----------
//
// docs/API_CONTRACT.md v2.0 fixes the 1-4 scale and its practice-difficulty
// mapping in one table; learner.js already owns those numbers (LEVELS), so we
// read them from there instead of restating "1-2 → easy, 3 → medium, 4 → hard".
//
// Tagging has two parts, deliberately:
//   * the MODEL may tag each question 1-4 — the content itself knows whether
//     the item is recall or application; and
//   * the fallback is DETERMINISTIC — an untagged (or invalid) question gets the
//     single level the target practice difficulty maps to. The same quiz
//     request therefore always produces a valid, repeatable tag set, whatever
//     the model returns.
//
// The level scale itself is A18/A31 territory (mastery → level, level → item).
// This file only stamps the stored `quiz_questions.difficulty` column.
const LEVEL_NUMBERS = [1, 2, 3, 4];

/** The lowest level whose contract practice difficulty is `difficulty`. */
function defaultLevel(difficulty) {
  return LEVEL_NUMBERS.find((level) => LEVELS[level].difficulty === difficulty) ?? 3;
}

/** The model's 1-4 tag when it is a real level, else the deterministic fallback. */
function tagLevel(difficulty, proposed) {
  // Accept a number or a numeric string ("2"); everything else (null, a
  // boolean, out of range, 2.5) falls back deterministically.
  const numeric = typeof proposed === 'number' || (typeof proposed === 'string' && proposed.trim() !== '');
  const value = numeric ? Number(proposed) : NaN;
  return LEVEL_NUMBERS.includes(value) ? value : defaultLevel(difficulty);
}

// Deterministic reading estimate, in minutes, stored per question. A higher
// level and a longer stem both take longer. The arithmetic is deliberately
// simple so it can be checked by hand.
const SECONDS_PER_LEVEL = 20;
const SECONDS_PER_WORD = 2;

function estimatedMinutesFor(text, level) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((level * SECONDS_PER_LEVEL + words * SECONDS_PER_WORD) / 60));
}

// Validate one raw question from the model. Returns a normalized question or null.
export function normalizeQuestion(raw, { topic, difficulty = 'medium' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (text.length < 10 || text.length > 400) return null;

  if (!Array.isArray(raw.choices) || raw.choices.length !== 4) return null;
  const choices = raw.choices.map((c) => (typeof c === 'string' ? c.trim() : ''));
  if (choices.some((c) => c.length === 0 || c.length > 200)) return null;
  if (new Set(choices.map((c) => c.toLowerCase())).size !== 4) return null; // no duplicates

  const answerText = typeof raw.answer === 'string' ? raw.answer.trim() : '';
  const answerIndex = choices.findIndex((c) => c.toLowerCase() === answerText.toLowerCase());
  if (answerIndex === -1) return null;

  const explanation = typeof raw.explanation === 'string' && raw.explanation.trim() !== ''
    ? raw.explanation.trim().slice(0, 500)
    : `The correct answer is "${choices[answerIndex]}".`;

  const level = tagLevel(difficulty, raw.difficulty);

  return {
    topic: topic.trim(),
    text: text.slice(0, 400),
    choices: CHOICE_IDS.map((id, i) => ({ id, text: choices[i] })),
    correctChoiceId: CHOICE_IDS[answerIndex],
    explanation,
    level,
    estimatedMinutes: estimatedMinutesFor(text, level),
    // Only passage indexes the model may reference; invalid ones are dropped later.
    cite: passageNumbers(raw.cite),
  };
}

/**
 * The citations a generated question points at, resolved against the retrieved
 * hits: the passage numbers the model listed (1-based), in order of first
 * reference. An out-of-range number resolves to nothing; when NOTHING resolves,
 * the two strongest hits are cited instead so the question still points at real
 * provided material rather than claiming to be grounded with no source.
 */
export function citationsForQuestion(hits, citeIndexes) {
  const picked = citeIndexes.slice(0, 3).map((n) => hits[n - 1]).filter(Boolean).map(toCitation);
  return picked.length > 0 ? picked : hits.slice(0, 2).map(toCitation);
}

// ---------- generation ----------

// Exported for studyAdvice (tutor "important questions" intent) — the quiz
// generator and the tutor reuse the exact same batch generation logic.
export async function generateQuestionBatch({ topic, difficulty, count, evidence, avoid = [] }, chat) {
  const systemPrompt = [
    'You write multiple-choice quiz questions strictly from the passages provided.',
    `Topic: ${topic}. Difficulty: ${difficulty}.`,
    UNTRUSTED_RULE,
    'Return ONLY a JSON object, no other text, in exactly this shape:',
    '{"questions":[{"question":"...","choices":["...","...","...","..."],"answer":"the exact correct choice text","explanation":"1-3 sentences explaining why","difficulty":2,"cite":[1,2]}]}',
    'Rules: exactly 4 unique choices; "answer" must match one choice exactly; "cite" lists passage numbers that support the question (1-based); every question must be answerable from the passages alone.',
    '"difficulty" is that ONE question\'s level as an integer 1-4 (1 = foundation/recall, 2 = developing, 3 = proficient/application, 4 = advanced/analysis). Omit it rather than guessing wildly.',
  ].join('\n');

  // Previously asked questions (stored, model-written text) travel in the USER
  // message — never the system prompt, which must stay free of everything but
  // trusted server-built instructions.
  const avoidBlock = avoid.length > 0
    ? `\n\nDo NOT repeat or paraphrase these questions the student has already seen:\n${avoid.map((text) => `- ${text}`).join('\n')}`
    : '';

  const content = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Passages:\n\n${evidence}\n\nWrite ${count} question${count === 1 ? '' : 's'}.${avoidBlock}` },
  ], { model: config.nimAssessModel, maxTokens: 2000 });

  const parsed = parseJsonLoose(content);
  if (!parsed || !Array.isArray(parsed.questions)) return [];
  return parsed.questions
    .map((raw) => normalizeQuestion(raw, { topic, difficulty }))
    .filter(Boolean);
}

/**
 * Run batch generation with bounded retries until `count` valid, pairwise
 * distinct questions are collected (or attempts run out).
 * Shared by generateQuiz and studyAdvice.importantQuestions so retry and
 * de-duplication semantics stay identical in both paths. May throw — the chat
 * call's failure is never swallowed into a fake result.
 *
 * Anti-repeat, in three layers:
 *  1. within one batch   — exact text and near-duplicates are always dropped;
 *  2. back-to-back quizzes — `recent` (the previous quiz's questions on the
 *     same topic) is passed to the model as "do not repeat these" AND enforced
 *     here on every attempt;
 *  3. last resort        — on a small corpus the model may genuinely have
 *     nothing new to say, so a final relaxed batch avoids a bare 422. Repeats
 *     are therefore emitted only when strict avoidance produced NOTHING.
 *
 * `events.js#isRepeatedQuestion` is the shared near-duplicate detector (token
 * overlap) — reused rather than re-implemented.
 */
export async function collectQuestions({ chat, topic, difficulty, evidence, count, recent = [] }) {
  const accepted = [];
  const acceptedTexts = [];

  const take = (batch, avoidRecent) => {
    for (const q of batch) {
      if (accepted.length >= count) break;
      // Exact text twice in one quiz, case-insensitively.
      if (acceptedTexts.some((t) => t.toLowerCase() === q.text.toLowerCase())) continue;
      // Near-duplicate of a question already accepted (the helper compares
      // against its own 5-item window, so hand it the most recent five).
      if (isRepeatedQuestion(q.text, acceptedTexts.slice(-5))) continue;
      if (avoidRecent && isRepeatedQuestion(q.text, recent)) continue;
      accepted.push(q);
      acceptedTexts.push(q.text);
    }
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS && accepted.length < count; attempt++) {
    const batch = await generateQuestionBatch({ topic, difficulty, count, evidence, avoid: recent }, chat);
    take(batch, true);
  }

  if (accepted.length === 0 && recent.length > 0) {
    const batch = await generateQuestionBatch({ topic, difficulty, count, evidence }, chat);
    take(batch, false);
  }

  return accepted;
}

// The previous quiz's question texts for this user+topic. Re-generating the
// same quiz back-to-back is not a study activity — the questions must change.
async function previousQuestionTexts(db, { userId, topic }) {
  const last = await db.get(
    'SELECT id FROM quizzes WHERE user_id = ? AND topic = ? ORDER BY created_at DESC LIMIT 1',
    userId, topic,
  );
  if (!last) return [];
  const rows = await db.all('SELECT text FROM quiz_questions WHERE quiz_id = ? ORDER BY idx LIMIT 5', last.id);
  return rows.map((row) => row.text);
}

// Persist the generated quiz: the quiz row plus one question row per accepted
// question. The answer key (`correct_choice_id`) is written HERE and nowhere
// else — generateQuiz strips it before building the response.
async function persistQuiz(db, { quizId, userId, topic, difficulty, createdAt, withCitations }) {
  await db.batch([
    {
      sql: 'INSERT INTO quizzes (id, user_id, topic, difficulty, question_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [quizId, userId, topic, difficulty, withCitations.length, createdAt],
    },
    ...withCitations.map(({ q, citations }, idx) => ({
      sql: `INSERT INTO quiz_questions
        (quiz_id, idx, text, choices_json, correct_choice_id, explanation, citations_json, difficulty, estimated_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [quizId, idx, q.text, JSON.stringify(q.choices), q.correctChoiceId, q.explanation, JSON.stringify(citations), q.level, q.estimatedMinutes],
    })),
  ], 'write');
}

export async function generateQuiz({ topic, questionCount = 5, difficulty, sourceIds = [], userId = 'default' }, { db, ai, vector }) {
  const chat = ai?.chatCompletion ?? chatCompletion;
  const quizTopic = topic.trim();
  // The practice difficulty the learner model chose (easy|medium|hard). It is
  // also the deterministic fallback for any question the model left untagged.
  const practiceDifficulty = difficulty ?? 'medium';

  const { hits, weakEvidence, evidence } = await retrieveForAssessment(quizTopic, { sourceIds, ai, vector, userId });
  requireMaterial(hits);
  const recent = await previousQuestionTexts(db, { userId, topic: quizTopic });

  const accepted = await collectQuestions({
    chat, topic: quizTopic, difficulty: practiceDifficulty, evidence, count: questionCount, recent,
  });

  if (accepted.length === 0) {
    throw new ApiError(422, 'QUIZ_CONTENT_INVALID',
      'The quiz model could not produce valid questions from this material. Try a broader topic or upload more material.');
  }

  // Citations are mapped once per question (order of first reference) and used
  // both for storage and for the response.
  const withCitations = accepted.map((q) => ({ q, citations: citationsForQuestion(hits, q.cite) }));

  const quizId = newId('quiz');
  await persistQuiz(db, {
    quizId, userId, topic: quizTopic, difficulty: practiceDifficulty, createdAt: nowIso(), withCitations,
  });

  // Strip the key before it ever reaches the response. Difficulty and reading
  // estimate are additive (contract v2.0 "additive change is the norm").
  const responseQuestions = withCitations.map(({ q, citations }, idx) => ({
    index: idx,
    text: q.text,
    choices: q.choices,
    difficulty: q.level,
    estimatedMinutes: q.estimatedMinutes,
    citations,
  }));

  return {
    id: quizId,
    topic: quizTopic,
    difficulty: practiceDifficulty,
    estimatedMinutes: accepted.reduce((sum, q) => sum + q.estimatedMinutes, 0),
    questions: responseQuestions,
    weakEvidence: weakEvidence ? true : undefined,
  };
}
