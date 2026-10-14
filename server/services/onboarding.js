// Conversational onboarding (v1.4 + v7 per-user rows). One call = one
// conversational turn: the assess-model interviewer asks exactly one short
// question per message, and anything it "learns" comes back as JSON that is
// validated here against a strict whitelist before storage — junk,
// hallucinated fields, sensitive data and injection attempts can never reach
// the profile.
//
// Write discipline: everything for a turn is kept in memory and written in a
// SINGLE batch at the very end, only after the model produced a usable reply.
// A model failure therefore leaves the row (or absence of one) exactly as it
// was — no half-started interviews. The profile row is keyed by the VERIFIED
// userId (Supabase uuid, or the prototype dev user 'default').

import { chatCompletion } from './nimChat.js';
import { parseJsonLoose } from './quizService.js';
import { UNTRUSTED_RULE } from './prompts.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/errors.js';
import { nowIso, loadProfileRow, saveProfileRow  } from '../store/sqlite.js';
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
const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FAMILIARITIES = new Set(['none', 'basic', 'familiar', 'confident']);

// ---------- interviewer prompt ----------

const INTERVIEWER_PROMPT = [
  'You are the friendly onboarding interviewer for Socius, an AI study companion.',
  'Your goal is to learn enough about the student to personalise their tutoring. Ask exactly ONE short question per message — never cram several questions into one.',
  'Cover, roughly in this order:',
  '1. interests and hobbies;',
  '2. goals and ambitions, and why they are studying (exam, project, research, or deep understanding);',
  '3. how familiar they already are with their main subject (none / basic / familiar / confident);',
  '4. their preferred explanation style (step-by-step / examples-first / visual / concise / guided-questions);',
  '5. optionally, deadlines or other constraints.',
  'Skipping or correcting an answer is always allowed: respond "no problem" and move on.',
  'In your FIRST reply also mention that answers are saved in the app\'s database to personalise learning and can be viewed, edited or deleted later on the Profile page.',
  'Never ask for name, age, contact details, address, health, politics or religion. If the student offers such sensitive information, do not store it and gently steer back to study topics.',
  UNTRUSTED_RULE,
  'Only claim to have learned something (extract/inferred) when the student actually said it; the memory of what was extracted is the "profile so far" JSON you receive each turn.',
  'When you have enough to personalise, or the student wants to finish, reply warmly and set done: true.',
  'Output ONLY JSON with exactly this shape (extract/inferred blocks may be omitted when nothing new was learned):',
  '{"reply":"...", "extract":{"interests":[],"goals":[{"label":"...","deadline":"YYYY-MM-DD"}],"purpose":"","explanationStyle":"","subjects":[{"subject":"","familiarity":"none|basic|familiar|confident","confidence":null}]},"inferred":{"explanationStyle":"","interests":[]},"done":false}',
  'Allowed enums: purpose: exam|project|research|deep-understanding|general. explanationStyle: step-by-step|examples-first|visual|concise|guided-questions.',
].join('\n');

const RETRY_REMINDER = [
  'Your previous answer was not usable. Output ONLY valid JSON, no prose, no markdown fences.',
  'Required shape: {"reply":"<non-empty string>","extract":{...},"inferred":{...},"done":false} — extract/inferred blocks may be omitted, "reply" and "done" may not.',
].join(' ');

// ---------- defensive parsing ----------

function parseFieldsJson(text) {
  try {
    const value = JSON.parse(text ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

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

// Validate the model's turn output. null → unusable → retried / 502.
function normalizeTurn(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reply = typeof raw.reply === 'string' ? raw.reply.trim() : '';
  if (reply === '') return null;
  return {
    reply,
    extract: raw.extract && typeof raw.extract === 'object' && !Array.isArray(raw.extract) ? raw.extract : {},
    inferred: raw.inferred && typeof raw.inferred === 'object' && !Array.isArray(raw.inferred) ? raw.inferred : {},
    done: raw.done === true,
  };
}

// ---------- whitelist extraction (invalid items are dropped SILENTLY) ----------

function cleanInterests(items, source) {
  if (!Array.isArray(items)) return null;
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const label = typeof item === 'string' ? item.trim() : typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > INTEREST_MAX_CHARS) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, source });
    if (out.length >= MAX_INTERESTS) break;
  }
  return out.length ? out : null;
}

function cleanGoals(items) {
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const item of items) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > 120) continue;
    let deadline = item?.deadline ?? null;
    if (deadline !== null && !(typeof deadline === 'string' && DEADLINE_RE.test(deadline))) deadline = null;
    out.push({ label, deadline, source: 'stated' });
    if (out.length >= MAX_GOALS) break;
  }
  return out.length ? out : null;
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

// ---------- prompt assembly ----------

function renderTranscript(entries) {
  return entries
    .slice(-RENDER_TURNS)
    .map((e) => `${e.role === 'assistant' ? 'Tutor' : 'Student'}: ${e.content === '' ? '(student has not said anything yet)' : e.content}`)
    .join('\n') || '(the conversation just started — greet the student and ask your first question)';
}

function buildMessages(fields, transcript, strict) {
  const user = [
    `Student profile so far (JSON): ${JSON.stringify({
      interests: fields.interests.map((i) => i.label),
      goals: fields.goals,
      purpose: fields.purpose ?? null,
      explanationStyle: fields.preferences.explanationStyle?.value ?? null,
    })}`,
    'Conversation so far:',
    renderTranscript(transcript),
  ].join('\n');
  const system = strict ? `${INTERVIEWER_PROMPT}\n\n${RETRY_REMINDER}` : INTERVIEWER_PROMPT;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
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
  const fields = parseFieldsJson(row?.fields_json);
  fields.interests = Array.isArray(fields.interests) ? fields.interests : [];
  fields.goals = Array.isArray(fields.goals) ? fields.goals : [];
  fields.preferences = fields.preferences && typeof fields.preferences === 'object' ? fields.preferences : {};

  let transcript = [...parseTranscriptJson(row?.transcript_json), { role: 'student', content: rawMessage }];

  let model = null;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !model; attempt++) {
      const content = await chat(buildMessages(fields, transcript, attempt > 0), {
        model: config.nimAssessModel,
        maxTokens: MAX_TOKENS,
      });
      model = normalizeTurn(parseJsonLoose(content));
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('[onboarding] model call failed:', err?.message ?? err);
    throw new ApiError(502, 'NIM_ERROR', 'The onboarding model could not be reached. Try again.');
  }
  if (!model) {
    throw new ApiError(502, 'NIM_ERROR', 'The onboarding model returned an unusable response. Try again.');
  }

  // ---- stated extraction (replaces whole values; junk dropped silently) ----
  const ex = model.extract;
  const statedInterests = cleanInterests(ex.interests, 'stated');
  if (statedInterests) fields.interests = statedInterests;
  const statedGoals = cleanGoals(ex.goals);
  if (statedGoals) fields.goals = statedGoals;
  if (typeof ex.purpose === 'string' && PURPOSES.has(ex.purpose)) fields.purpose = ex.purpose;
  if (typeof ex.explanationStyle === 'string' && EXPLANATION_STYLES.has(ex.explanationStyle)) {
    fields.preferences.explanationStyle = { value: ex.explanationStyle, source: 'stated' };
  }
  const subjects = cleanSubjects(ex.subjects); // replaces learner_subjects entirely

  // ---- inferred guesses (never overwrite a stated answer; never touch
  // goals, purpose or subjects — those only change when stated) ----
  const inf = model.inferred;
  if (!fields.preferences.explanationStyle
    && typeof inf.explanationStyle === 'string'
    && EXPLANATION_STYLES.has(inf.explanationStyle)) {
    fields.preferences.explanationStyle = { value: inf.explanationStyle, source: 'inferred' };
  }
  const inferredInterests = cleanInterests(inf.interests, 'inferred');
  if (inferredInterests) {
    const known = new Set(fields.interests.map((i) => String(i?.label ?? '').toLowerCase()));
    for (const item of inferredInterests) {
      const key = item.label.toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      fields.interests.push({ label: item.label, source: 'inferred' });
      if (fields.interests.length >= MAX_INTERESTS) break;
    }
  }

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
