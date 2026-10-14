// Study-planning intents for the tutor (the "what should I study" side). Two
// of the three answers are fully deterministic and NEVER call the AI — the
// learner model already holds every number, and a beginner can verify each
// one against the database. The third (practice questions) reuses the quiz
// generator so the wording/prompts/provenance rules stay identical.
//
// All functions are pure over their (db, ai, vector) dependencies, so tests
// can pass in-memory databases and stubs. DB reads go through the async engine
// facade (db.get/db.all) like every other module.

import { retrieve, toCitation, hitScore } from './retrieval.js';
import { wrapPassages } from './prompts.js';
import { collectQuestions } from './quizService.js';
import { needsRevision, suggestNext, difficultyFor } from './learner.js';
import { config } from '../config.js';

// ---------- intent classification (pure, deterministic) ----------

// Checked in precedence order: first match wins. Order matters because a
// revision question can contain a coincidental "important"/"prepare" word.
const INTENT_RULES = [
  { intent: 'revise-next', re: /what should i (revise|study|do next)|what am i weak|weak (at|on)|which topic should i|not revised|haven'?t revised|focus on|before my exam|next topic/ },
  { intent: 'important-questions', re: /important (questions|concepts|topics)|key (concepts|questions)|exam (-|oriented |ready |preparedness )?(questions|preparation|practice)|practice questions|what should i prepare|likely questions/ },
  { intent: 'progress', re: /how am i doing|my (progress|mastery|accuracy|weaknesses)|what have i (studied|done)|my history/ },
];

export function classifyIntent(questionText) {
  const q = String(questionText ?? '').trim().toLowerCase();
  if (q === '') return { intent: 'normal' };
  for (const rule of INTENT_RULES) {
    if (rule.re.test(q)) return { intent: rule.intent };
  }
  return { intent: 'normal' };
}

// Deterministic topic string for the practice-question call: the words left
// after stripping the matched intent keywords and light filler words.
const INTENT_PHRASES = [
  'important questions', 'important concepts', 'important topics',
  'key concepts', 'key questions', 'practice questions', 'likely questions',
  'exam questions', 'exam preparation', 'exam practice', 'exam oriented',
  'exams', 'exam', 'practices', 'practice', 'preparations', 'preparation',
  'questions', 'question', 'concepts', 'concept', 'topics', 'topic',
  'prepare', 'give me', 'show me', 'what are', 'what should i', 'list', 'please',
];
const EDGE_FILLERS = /^(and|from|in|on|about|for|of|my|the|a|an|to|chapter|chapters)\b\s*|\s+\b(and|from|in|on|about|for|of|my|the|a|an|to|chapter|chapters)$/gi;

function topicForPracticeQuestions(questionText) {
  let remaining = String(questionText ?? '');
  for (const phrase of INTENT_PHRASES) {
    remaining = remaining.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  remaining = remaining.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3 && remaining !== ''; i++) { // remove stacked edge fillers
    remaining = remaining.replace(EDGE_FILLERS, ' ').replace(/\s+/g, ' ').trim();
  }
  return remaining !== '' ? remaining.slice(0, 80) : 'your material';
}

// ---------- a) revision advice (deterministic, no AI) ----------

const masteryPercentOf = (row) => Math.round((row.correct / row.total) * 100);
const byWorstMastery = (a, b) => (a.correct / a.total) - (b.correct / b.total);

export async function revisionAdvice(db, userId = 'default') {
  const rows = await db.all('SELECT * FROM learner_topics WHERE user_id = ? ORDER BY last_practiced_at DESC', userId);

  if (rows.length === 0) {
    return {
      answer: 'You have no quiz attempts yet, so there is no practice history to base a revision plan on. '
        + 'Generate a diagnostic quiz on any topic from your study material — your result will set the starting difficulty for that topic.',
      citations: [],
      needsContent: false,
      intent: 'revise-next',
      suggestedNext: null,
    };
  }

  const flagged = rows.filter(needsRevision).sort(byWorstMastery);
  const pool = flagged.length > 0 ? flagged : [...rows].sort(byWorstMastery);
  const picked = pool[0];
  const mastery = masteryPercentOf(picked);
  const difficulty = difficultyFor(picked.correct / picked.total);

  const why = flagged.length > 0
    ? `mastery ${mastery}% over ${picked.total} attempts — below the 0.6 revision line`
    : `weakest overall at ${mastery}%`;
  const others = pool.slice(1, 3).map((row) => `«${row.topic}» (${masteryPercentOf(row)}%)`);

  const lines = [
    `Start with «${picked.topic}» — ${why}.`,
    `Next action: generate a quiz on «${picked.topic}» — difficulty «${difficulty}» is the level your learner model suggests next.`,
  ];
  if (others.length > 0) lines.push(`Also worth another pass: ${others.join(' and ')}.`);

  return {
    answer: lines.join(' '),
    citations: [],
    needsContent: false,
    intent: 'revise-next',
    suggestedNext: { topic: picked.topic, difficulty },
  };
}

// ---------- b) progress roll-up (deterministic, no AI) ----------

export async function progressAdvice(db, userId = 'default') {
  const topicRows = await db.all('SELECT * FROM learner_topics WHERE user_id = ? ORDER BY last_practiced_at DESC', userId);
  const attempts = await db.all('SELECT correct, total FROM quiz_attempts WHERE user_id = ?', userId);
  const activityCount = (await db.get('SELECT COUNT(*) AS n FROM activity WHERE user_id = ?', userId)).n;

  const questionsAnswered = attempts.reduce((sum, a) => sum + a.total, 0);
  const correctAnswers = attempts.reduce((sum, a) => sum + a.correct, 0);
  const accuracyPercent = questionsAnswered > 0 ? Math.round((correctAnswers / questionsAnswered) * 100) : 0;

  const scored = topicRows.filter((row) => row.total > 0);
  const scoreOf = (row) => row.correct / row.total;
  const sorted = [...scored].sort(byWorstMastery); // one copy: weakest first
  const worst = sorted[0] ?? null;
  // Strongest topic: first of the max-ratio group (stable sort keeps the
  // original order within ties — identical to the old best-first sort's pick).
  const bestRatio = Math.max(...sorted.map(scoreOf));
  const best = sorted.find((row) => scoreOf(row) === bestRatio) ?? null;
  const reviseList = topicRows.filter(needsRevision).sort(byWorstMastery).slice(0, 3);

  if (attempts.length === 0 && topicRows.length === 0) {
    return {
      answer: 'There is no recorded practice yet — take a quiz on any topic from your material and your progress will start building here.',
      quizzesTaken: 0,
      questionsAnswered: 0,
      accuracyPercent: 0,
      bestTopic: null,
      worstTopic: null,
      needsRevision: [],
      recentActivityCount: activityCount,
      citations: [],
      needsContent: false,
      intent: 'progress',
    };
  }

  const parts = [`You have taken ${attempts.length} quiz${attempts.length === 1 ? '' : 'zes'}, answering ${questionsAnswered} questions with ${accuracyPercent}% accuracy.`];
  if (best) parts.push(`Strongest topic: «${best.topic}» (${masteryPercentOf(best)}%).`);
  if (worst && (!best || worst.topic !== best.topic)) parts.push(`Needs the most work: «${worst.topic}» (${masteryPercentOf(worst)}%).`);
  if (reviseList.length > 0) {
    parts.push(`Topics flagged for revision: ${reviseList.map((r) => `«${r.topic}» (${masteryPercentOf(r)}%)`).join(', ')}.`);
  }
  parts.push(`${activityCount} activity records are logged so far.`);

  return {
    answer: parts.join(' '),
    quizzesTaken: attempts.length,
    questionsAnswered,
    accuracyPercent,
    bestTopic: best ? { topic: best.topic, masteryPercent: masteryPercentOf(best) } : null,
    worstTopic: worst ? { topic: worst.topic, masteryPercent: masteryPercentOf(worst) } : null,
    needsRevision: reviseList.map((r) => ({ topic: r.topic, masteryPercent: masteryPercentOf(r) })),
    recentActivityCount: activityCount,
    citations: [],
    needsContent: false,
    intent: 'progress',
  };
}

// ---------- c) practice questions from REAL retrieved material ----------

const PRACTICE_PREFIX = 'Practice questions drawn from your material:';
const PRACTICE_COUNT = 5;

// Citations come ONLY from the retrieved hits (order of first reference), not
// from anything the model said. Mapped per question like quizService does.
function buildCitations(hits, questions) {
  const seen = new Set();
  const out = [];
  const push = (hit) => {
    if (out.length >= 6) return;
    const cite = toCitation(hit);
    const key = `${cite.sourceId}|${cite.excerpt}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cite);
  };
  for (const q of questions) {
    const cited = q.cite.slice(0, 3).map((n) => hits[n - 1]).filter(Boolean);
    for (const hit of (cited.length > 0 ? cited : hits.slice(0, 2))) {
      push(hit);
    }
  }
  return out;
}

function formatPracticeAnswer(topic, questions) {
  const lines = [PRACTICE_PREFIX, ''];
  questions.forEach((q, i) => {
    const letters = ['A', 'B', 'C', 'D'];
    const choices = q.choices.map((c, j) => `${letters[j]}) ${c.text}`);
    const letter = letters[q.choices.findIndex((c) => c.id === q.correctChoiceId)];
    lines.push(`**${i + 1}. ${q.text}**`);
    lines.push(choices.join('  '));
    lines.push(`Answer: ${letter} — ${q.explanation}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

export async function importantQuestions(db, { question, sourceIds = [] }, { ai, vector, userId = 'default' } = {}) {
  const NO_MATERIAL = {
    answer: "I couldn't find enough in your study materials to compose practice questions on this — add or select material covering the topic first.",
    citations: [],
    needsContent: true,
    intent: 'important-questions',
  };

  // Breadth retrieval (owner-scoped); the relative evidence filter sorts
  // relevance, then we apply the absolute sanity bound here (same as
  // generateQuiz).
  const hits = await retrieve(question, { sourceIds, k: 8, minScore: 0, ai, vector, userId });
  if (hits.length === 0 || hits.every((hit) => (hitScore(hit) ?? 0) < config.ragMinSimilarity)) {
    return NO_MATERIAL; // honest RETRIEVAL failure — never a fabricated list
  }

  const evidence = wrapPassages(hits);
  const topic = topicForPracticeQuestions(question);

  // generateQuestionBatch already parses, validates and normalizes the loose
  // model JSON for every question — collectQuestions reuses it as-is with the
  // exact same bounded retries and lowercase dedupe as the quiz generator.
  // Its chat call may throw (e.g. provider down) and that failure is allowed
  // to propagate: never swallow it into a fake answer.
  const accepted = await collectQuestions(
    { chat: ai?.chatCompletion, topic, difficulty: 'medium', evidence, count: PRACTICE_COUNT },
  );

  if (accepted.length === 0) {
    return {
      answer: 'I could not compose valid practice questions from your study materials for this — try a broader topic or add more material that covers it.',
      citations: [],
      needsContent: true,
      intent: 'important-questions',
    };
  }

  return {
    answer: formatPracticeAnswer(topic, accepted),
    citations: buildCitations(hits, accepted),
    needsContent: false,
    intent: 'important-questions',
  };
}
