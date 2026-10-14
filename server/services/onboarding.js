// Conversational onboarding (v1.4 + v7 per-user rows). One call = one
// conversational turn: the interviewer asks exactly one short question per
// message, and anything it "learns" comes back as JSON that is validated here
// against a strict whitelist before storage — junk, hallucinated fields,
// sensitive data and injection attempts can never reach the profile.
//
// Security: the student's own words are UNTRUSTED input. They reach the model
// only as numbered <passage id="n"> blocks inside the USER message (the same
// delimiter convention organizer.js uses for untrusted document text), the
// system message is rendered from trusted fields only (services/prompts.js —
// the prompt itself lives there as ONBOARDING_INTERVIEW), and an embedded
// closing delimiter is neutralised in the rendered copy so an answer cannot
// break out of its block. Off-list fields the model invents are dropped
// silently: only the whitelist below is ever stored.
//
// Write discipline: everything for a turn is kept in memory and written in a
// SINGLE batch at the very end, only after the model produced a usable reply. A
// model failure therefore leaves the row (or absence of one) exactly as it was —
// no half-started interviews. The profile row is keyed by the VERIFIED userId
// (Supabase uuid, or the prototype dev user 'default'), so redoing onboarding
// rewrites that ONE row: duplicate rows are structurally impossible, and every
// stated value replaces its predecessor rather than piling up beside it.
//
// Graceful degradation: when the AI call itself fails (provider unreachable,
// timeout, rejected key) the interview completes with the profile already
// collected instead of leaving the student stuck behind a broken dependency.
// Unusable model OUTPUT is a different case and still fails loudly (NIM_ERROR),
// so a real prompt/model defect stays visible instead of being papered over.

import { chatCompletion } from './nimChat.js';
import { parseJsonLoose } from './quizService.js';
import { renderPrompt, ONBOARDING_INTERVIEW } from './prompts.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { nowIso, loadProfileRow, parseJsonObject, saveProfileRow } from '../store/sqlite.js';
// Shared v1.4 enums come from constants.js — the single source of truth
// (routes never get imported from services).
import { PURPOSES, EXPLANATION_STYLES } from '../constants.js';

const MAX_ATTEMPTS = 2;      // bounded retries when the model returns unusable JSON
const MAX_TOKENS = 1000;
const MAX_TURN_COUNT = 6;    // server completes the interview automatically here
const MAX_TRANSCRIPT = 14;   // in-memory growth cap; fields_json is the real memory
const RENDER_TURNS = 10;     // how much of the conversation the model sees
const MAX_INTERESTS = 12;
const INTEREST_MAX_CHARS = 40;
const MAX_GOALS = 6;
const MAX_SUBJECTS = 12;
const MAX_REPLY_CHARS = 600; // a reply is one short question, never an essay
const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FAMILIARITIES = new Set(['none', 'basic', 'familiar', 'confident']);

// Trusted strings (never model output, never student text).
const RETRY_REMINDER = [
  'Your previous answer was not usable. Output ONLY valid JSON, no prose, no markdown fences.',
  'Required shape: {"reply":"<non-empty string>","extract":{...},"inferred":{...},"done":false} — extract/inferred blocks may be omitted, "reply" and "done" may not.',
].join(' ');

// Shown when the interviewer model could not be reached at all. It promises
// nothing the server did not actually do: the profile is saved in its current
// state and can be edited from the Profile page.
const UNAVAILABLE_REPLY = [
  'I could not reach the AI interviewer just now, so instead of leaving you stuck I saved your profile as it is.',
  'You can add or change your goal, subjects and preferred explanation style any time on the Profile page.',
].join(' ');

// ---------- untrusted-input rendering ----------

// An answer containing "</passage>" would otherwise look like the end of its
// block, letting the rest of the text read as instructions. Neutralise the
// delimiter in the RENDERED copy only — what we store stays the student's words.
function escapeDelimiters(text) {
  return text.replaceAll('</passage', '<\\/passage');
}

// The conversation as the model sees it: its own questions as plain lines, each
// student answer wrapped in its own numbered, untrusted passage block. The
// opening turn has no student text yet, so no block is emitted for it.
function renderTranscript(entries) {
  const window = entries.slice(-RENDER_TURNS);
  const lines = [];
  let passageId = 0;
  for (const entry of window) {
    if (entry.role === 'assistant') {
      lines.push(`Tutor: ${entry.content}`);
      continue;
    }
    if (entry.content === '') {
      lines.push('Student: (has not said anything yet)');
      continue;
    }
    passageId += 1;
    lines.push([
      `Student answer ${passageId} (untrusted, student-written):`,
      `<passage id="${passageId}">`,
      escapeDelimiters(entry.content),
      '</passage>',
    ].join('\n'));
  }
  return lines.join('\n') || '(the conversation just started — greet the student and ask your first question)';
}

function buildMessages(fields, transcript, strict) {
  const { system, user } = renderPrompt(ONBOARDING_INTERVIEW, {
    // Student-written text travels through `request` (user message only).
    request: {
      profileJson: JSON.stringify({
        interests: fields.interests.map((i) => i.label),
        goals: fields.goals,
        purpose: fields.purpose ?? null,
        explanationStyle: fields.preferences.explanationStyle?.value ?? null,
      }),
      transcript: renderTranscript(transcript),
    },
    // Trusted field: null removes the reminder line entirely.
    fields: { retryReminder: strict ? RETRY_REMINDER : null },
  });
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------- defensive parsing ----------

// A corrupt transcript must never crash a turn — filter to well-formed entries.
function parseTranscriptJson(text) {
  try {
    const value = JSON.parse(text ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((e) => (e?.role === 'student' || e?.role === 'assistant') && typeof e?.content === 'string');
  } catch {
    return [];
  }
}

// Validate the model's turn output. null → unusable → retried / 502. Bounded
// length keeps one runaway reply from swallowing the transcript budget.
function normalizeTurn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reply = typeof raw.reply === 'string' ? raw.reply.trim().slice(0, MAX_REPLY_CHARS) : '';
  if (reply === '') return null;
  return {
    reply,
    extract: raw.extract && typeof raw.extract === 'object' && !Array.isArray(raw.extract) ? raw.extract : {},
    inferred: raw.inferred && typeof raw.inferred === 'object' && !Array.isArray(raw.inferred) ? raw.inferred : {},
    done: raw.done === true,
  };
}

// ---------- whitelist extraction (invalid items are dropped SILENTLY) ----------

/**
 * Build each item through `build` (null = unusable), cap the list, and return
 * null when nothing survived so the caller leaves the stored value untouched.
 */
function cleanList(items, build, cap) {
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const item of items) {
    const value = build(item);
    if (value === null) continue;
    out.push(value);
    if (out.length >= cap) break;
  }
  return out.length ? out : null;
}

function cleanInterests(items, source) {
  const seen = new Set();
  return cleanList(items, (item) => {
    const label = typeof item === 'string' ? item.trim() : typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > INTEREST_MAX_CHARS) return null;
    const key = label.toLowerCase(); // case-insensitive dedupe
    if (seen.has(key)) return null;
    seen.add(key);
    return { label, source };
  }, MAX_INTERESTS);
}

function cleanGoals(items) {
  return cleanList(items, (item) => {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > 120) return null;
    let deadline = item?.deadline ?? null;
    if (deadline !== null && !(typeof deadline === 'string' && DEADLINE_RE.test(deadline))) deadline = null;
    return { label, deadline, source: 'stated' };
  }, MAX_GOALS);
}

// learner_subjects is keyed by subject — case-insensitive dedupe, last wins.
function cleanSubjects(items) {
  if (!Array.isArray(items)) return null;
  const clean = new Map();
  for (const item of items) {
    const subject = typeof item?.subject === 'string' ? item.subject.trim() : '';
    if (subject.length < 1 || subject.length > 60) continue;
    if (!FAMILIARITIES.has(item?.familiarity)) continue;
    const confidence = item?.confidence ?? null;
    if (confidence !== null && (!Number.isInteger(confidence) || confidence < 1 || confidence > 5)) continue;
    clean.set(subject.toLowerCase(), { subject, familiarity: item.familiarity, confidence, source: 'stated' });
    if (clean.size >= MAX_SUBJECTS) break;
  }
  return clean.size ? [...clean.values()] : null;
}

/** Stated extraction on `fields`: a presented value REPLACES what was stored,
 *  junk is dropped silently. Returns the whitelisted subjects, or null when the
 *  student stated none (learner_subjects then stays untouched). */
function applyStatedExtract(fields, extract) {
  const statedInterests = cleanInterests(extract.interests, 'stated');
  if (statedInterests) fields.interests = statedInterests;
  const statedGoals = cleanGoals(extract.goals);
  if (statedGoals) fields.goals = statedGoals;
  if (typeof extract.purpose === 'string' && PURPOSES.has(extract.purpose)) fields.purpose = extract.purpose;
  if (typeof extract.explanationStyle === 'string' && EXPLANATION_STYLES.has(extract.explanationStyle)) {
    fields.preferences.explanationStyle = { value: extract.explanationStyle, source: 'stated' };
  }
  return cleanSubjects(extract.subjects); // replaces learner_subjects entirely
}

// Inferred guesses: never overwrite a stated answer, and never touch goals,
// purpose or subjects — those only change when stated.
function applyInferredGuesses(fields, inferred) {
  if (!fields.preferences.explanationStyle
    && typeof inferred.explanationStyle === 'string'
    && EXPLANATION_STYLES.has(inferred.explanationStyle)) {
    fields.preferences.explanationStyle = { value: inferred.explanationStyle, source: 'inferred' };
  }
  const guessed = cleanInterests(inferred.interests, 'inferred');
  if (!guessed) return;
  const known = new Set(fields.interests.map((i) => String(i?.label ?? '').toLowerCase()));
  for (const item of guessed) {
    const key = item.label.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    fields.interests.push({ label: item.label, source: 'inferred' });
    if (fields.interests.length >= MAX_INTERESTS) break;
  }
}

// ---------- the one public function ----------

export async function turnOnboarding(db, rawMessage, { ai, userId = 'default' } = {}) {
  const chat = ai?.chatCompletion ?? chatCompletion;
  const row = await loadProfileRow(db, userId);
  // Only a finished interview blocks; skipping is retryable ('new' and
  // 'skipped' both (re)start here).
  if (row?.state === 'completed') {
    throw new ApiError(409, 'ONBOARDING_COMPLETE', 'Onboarding already finished.');
  }

  // ---- everything below happens in memory until the single final write ----
  const fields = parseJsonObject(row?.fields_json);
  fields.interests = Array.isArray(fields.interests) ? fields.interests : [];
  fields.goals = Array.isArray(fields.goals) ? fields.goals : [];
  fields.preferences = fields.preferences && typeof fields.preferences === 'object' ? fields.preferences : {};

  let transcript = [...parseTranscriptJson(row?.transcript_json), { role: 'student', content: rawMessage }];

  let model = null;
  let aiUnavailable = false;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !model; attempt++) {
      const content = await chat(buildMessages(fields, transcript, attempt > 0), {
        // Assessment-grade task/model, both from config (aiRouter.TASKS.assess →
        // config.aiRouter.assessModel, which equals NIM_ASSESS_MODEL unless the
        // operator overrides it). Passing the task keeps the router's log and
        // cost accounting truthful about what was asked of the model.
        task: 'assess',
        model: config.nimAssessModel,
        maxTokens: MAX_TOKENS,
      });
      model = normalizeTurn(parseJsonLoose(content));
    }
  } catch (err) {
    // The call itself failed (provider down, timeout, key rejected). Retrying
    // here would only repeat what aiRouter already retried, so complete the
    // interview with what we have rather than blocking the student.
    console.error('[onboarding] model call failed:', err?.message ?? err);
    aiUnavailable = true;
  }

  if (aiUnavailable) {
    // One clean write: interview marked finished, working memory cleared, the
    // profile kept exactly as collected. Nothing half-started is persisted.
    await saveProfileRow(db, userId, {
      state: 'completed',
      transcriptJson: '[]',
      fieldsJson: JSON.stringify(fields),
    });
    return {
      reply: UNAVAILABLE_REPLY,
      state: 'completed',
      questionsAsked: transcript.filter((e) => e.role === 'assistant').length,
      done: true,
      degraded: true, // additive: this setup is defaults, not an interview result
    };
  }

  if (!model) {
    throw new ApiError(502, 'NIM_ERROR', 'The onboarding model returned an unusable response. Try again.');
  }

  // ---- stated extraction (replaces whole values; junk dropped silently) ----
  const subjects = applyStatedExtract(fields, model.extract);

  // ---- inferred guesses (never overwrite a stated answer; never touch
  // goals, purpose or subjects — those only change when stated) ----
  applyInferredGuesses(fields, model.inferred);

  // ---- assistant turn, count, finish check ----
  transcript.push({ role: 'assistant', content: model.reply });
  if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(-MAX_TRANSCRIPT);
  const questionsAsked = transcript.filter((e) => e.role === 'assistant').length;
  const done = model.done === true || questionsAsked >= MAX_TURN_COUNT;

  const state = done ? 'completed' : 'in_progress';
  const storedTranscript = done ? [] : transcript; // finished → working memory cleared

  // ---- the single write for this turn (keyed by the verified user id) ----
  await saveProfileRow(db, userId, {
    state,
    transcriptJson: JSON.stringify(storedTranscript),
    fieldsJson: JSON.stringify(fields),
  });
  if (subjects) {
    await db.batch([
      { sql: 'DELETE FROM learner_subjects WHERE user_id = ?', args: [userId] },
      ...subjects.map((s) => ({
        sql: 'INSERT INTO learner_subjects (user_id, subject, familiarity, confidence, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [userId, s.subject, s.familiarity, s.confidence, s.source, nowIso()],
      })),
    ], 'write');
  }

  return { reply: model.reply, state, questionsAsked, done };
}
