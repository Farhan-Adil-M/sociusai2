// Tutoring: retrieve grounded passages, ask the model to answer ONLY from them,
// return the answer with citations mapped from real retrieved metadata.
// v1.4 (M3): the learner profile may personalise style/structure — facts still
// come only from the passages. With no usable learner context and no explicit
// approach, the prompt is byte-identical to the earlier version.
// Abstains are friendly and offer REAL next topics from the same source scope
// (see topicSuggestions.js); the successful-answer shape is unchanged.

import { chatCompletion } from './nimChat.js';
import { retrieve, toCitation } from './retrieval.js';
import { fetchTopicSuggestions } from './topicSuggestions.js';
import { wrapPassages, UNTRUSTED_RULE } from './prompts.js';
import { config } from '../config.js';
import { APPROACH_ORDER, chooseApproach, isRepeatedQuestion, lastApproach, recordEvent } from './events.js';
import { buildLearnerBlock, buildLearnerContext, describeApproach } from './personalization.js';

// Abstain copy: friendly, short, honest. When the student's material has real
// topics to offer, the message invites them to pick one; when it does not, it
// keeps the advice line instead — never promise options we don't have.
const ABSTAIN_OPENING = "Oh — looks like that's not in the material you've selected. ";
const ABSTAIN_OFFER = 'Want to learn about one of these instead?';
const ABSTAIN_ADVICE = 'Try adding material on this topic, or ask about something covered in your sources.';
const MODEL_ABSTAIN_TOKEN = 'EVIDENCE_INSUFFICIENT';

// Approach values a client may request (the contract enum; `simpler` and
// `different` are requests only, not saved styles). Unknown values are
// ignored so arbitrary client text can never steer the prompt.
const REQUESTABLE_APPROACHES = new Set([...APPROACH_ORDER, 'simpler', 'different']);

// Rule lines added ONCE per personalisation; they must never leak facts.
const PERSONALISATION_RULES = [
  '- Learner context below may shape explanation style, examples, structure, and teaching strategy.',
  '- FACTS must still come ONLY from the passages. Never use the learner context to add, justify, or alter any factual claim.',
  '- Use an interest only when it genuinely helps explain the concept; never force an analogy into every answer.',
  '- If the context shows confusion, simplify, revisit prerequisites briefly, change the example, and offer one follow-up question.',
  '- If mastery is strong (80%+), go deeper: harder applications over repetition.',
];

function buildSystemPrompt(context, approachUsed) {
  const base = [
    'You are Socius AI, a tutor who answers strictly from the passages the student provides.',
    'Rules:',
    UNTRUSTED_RULE,
    '- Use ONLY the information in the passages. If the passages do not contain the answer, say you could not find it in the study materials.',
    '- Write a clear, concise explanation a student can understand.',
    '- After your explanation, cite your sources inline like [1] or [2][3], matching the passage numbers.',
    `- If the passages do not contain enough information to answer, reply with exactly ${MODEL_ABSTAIN_TOKEN} and nothing else — do not use outside knowledge.`,
    'Never invent facts, filenames, page numbers, or sources.',
  ];

  if (context === null && approachUsed === null) return base.join('\n');

  let extra = `\n\n${PERSONALISATION_RULES.join('\n')}`;
  if (approachUsed !== null) {
    extra += `\nTeaching approach for this answer: ${approachUsed} — ${describeApproach(approachUsed)}`;
  }
  if (context !== null) {
    extra += `\n<learner-context>\n${buildLearnerBlock(context)}\n</learner-context>`;
  }
  return base.join('\n') + extra;
}

/** Best-effort event recording; a logging failure must never fail the answer. */
async function answerContextEvents(db, { question, matchedTopic, previous, explicit, approachUsed, approachGiven, userId }) {
  try {
    // Repeated question? The route logs the CURRENT question AFTER this call,
    // so this history holds only earlier questions (this user's own).
    const rows = await db.all("SELECT detail FROM activity WHERE type = 'question' AND user_id = ? ORDER BY id DESC LIMIT 5", userId);
    const recent = rows
      .map((r) => (typeof r.detail === 'string' && r.detail.startsWith('Asked: ') ? r.detail.slice(7) : ''))
      .filter((t) => t !== '');
    if (isRepeatedQuestion(question.trim(), recent)) {
      await recordEvent(db, {
        kind: 'repeated_question',
        topic: matchedTopic,
        detail: { note: 'the student asked a near-identical question recently — treat as a possible confusion signal, not a proven misconception' },
        userId,
      });
    }
  } catch { /* observability must not break answering */ }

  if (approachUsed === null) return;
  try {
    // The student asked to hear this AGAIN (differently): a confusion signal.
    if (explicit === 'different') {
      await recordEvent(db, { kind: 'explain_again', topic: matchedTopic, detail: { requested: true }, userId });
    }
    // A change is logged when the approach differs from the last one recorded
    // for this topic (a saved style applying for the first time is a change:
    // from=null), or when the student explicitly requested one.
    if (approachGiven || approachUsed !== previous) {
      await recordEvent(db, { kind: 'approach_change', topic: matchedTopic, detail: { from: previous, to: approachUsed }, userId });
    }
  } catch { /* observability must not break answering */ }
}

// The response BOTH refusal paths return: every existing abstain field plus
// deterministic `suggestions` (0-4 real topics from the same source scope).
// Suggestions are best-effort — a failed lookup must never turn an honest
// abstain into a 500, so it degrades to an empty list and the advice line.
async function abstainAnswer(db, sourceIds, userId) {
  let suggestions = [];
  try {
    suggestions = await fetchTopicSuggestions(db, sourceIds, userId);
  } catch { /* the abstain itself must still answer */ }
  const answer = suggestions.length > 0 ? ABSTAIN_OPENING + ABSTAIN_OFFER : ABSTAIN_OPENING + ABSTAIN_ADVICE;
  return { answer, citations: [], needsContent: true, model: config.nimChatModel, suggestions };
}

export async function answerQuestion({ question, sourceIds = [], db, approach, userId = 'default' }, { ai, vector } = {}) {
  // Vector search is user-scoped first: another student's chunks can never be
  // cited even when the request carries no sourceIds filter.
  const hits = await retrieve(question, { sourceIds, ai, vector, userId });

  if (hits.length === 0) {
    return abstainAnswer(db, sourceIds, userId);
  }

  // ---- learner-context personalisation (deterministic, db reads only) ----
  const context = await buildLearnerContext(db, { question, userId });
  const matchedTopic = context?.topics?.[0] ?? null;
  const previous = await lastApproach(db, matchedTopic, userId);
  const preferred = context?.style ?? null; // chooseApproach re-validates: not a saved style → ignored
  const explicit = typeof approach === 'string' && REQUESTABLE_APPROACHES.has(approach.trim()) ? approach.trim() : null;
  const approachGiven = explicit !== null;
  const approachUsed = chooseApproach({ explicit, previous, preferred });

  const evidence = wrapPassages(hits);
  const systemPrompt = buildSystemPrompt(context, approachUsed);

  const chat = ai?.chatCompletion ?? chatCompletion;
  const answer = await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Passages:\n\n${evidence}\n\nStudent question: ${question}` },  ], { model: config.nimChatModel });

  // The grounding contract with the model: an explicit refusal token means the
  // passages did not cover the question — abstain honestly instead of trusting
  // outside knowledge it may have used anyway.
  if (answer.trim().toUpperCase() === MODEL_ABSTAIN_TOKEN) {
    return abstainAnswer(db, sourceIds, userId);
  }

  await answerContextEvents(db, { question, matchedTopic, previous, explicit, approachUsed, approachGiven, userId });

  return {
    answer,
    citations: hits.map(toCitation),
    needsContent: false,
    model: config.nimChatModel,
    ...(approachUsed !== null ? { approachUsed } : {}),
  };
}
