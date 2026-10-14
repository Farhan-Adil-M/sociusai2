// Learner profile (v1.4 + v7 ownership): one profile row per verified user —
// the row id IS the user id (a Supabase users uuid, or the fixed dev user
// 'default' in prototype mode). Validation is deterministic; no AI involved.
// The first write in supabase mode kicks off per-user demo seeding
// (ensureUserSeeded) so a brand-new account opens with answerable material.
//
// Wave 4 (stated-vs-inferred preferences API): GET /preferences exposes the
// stored profile as two labelled buckets — stated (the student declared it)
// and inferred (the app guessed it) — via services/personalization.js's
// readLearnerPreferences, a deterministic read with no model call. Confirming
// an inferred preference is an ordinary PATCH: every written item is stored as
// source "stated", which is what moves it between the buckets. Two briefed
// preferences (study pace, availability) have no stored field yet and are
// rejected explicitly rather than silently dropped — see UNSTORABLE_FIELDS.

import express from 'express';
import { ApiError } from '../middleware/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { nowIso, loadProfileRow, saveProfileRow, deleteProfileRow } from '../store/sqlite.js';
import { ensureUserSeeded } from '../store/sqlite-vector.js';
import { PURPOSES, EXPLANATION_STYLES } from '../constants.js';
import { turnOnboarding } from '../services/onboarding.js';
import { readLearnerPreferences } from '../services/personalization.js';

const FAMILIARITIES = new Set(['none', 'basic', 'familiar', 'confident']);
const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Learning preferences the product brief lists (study pace, availability)
// that the frozen v1.4 profile schema cannot store: fields_json holds only
// interests / goals / purpose / preferences.explanationStyle, plus
// learner_subjects. PATCH replaces every provided key wholesale, so accepting
// either field would silently drop the student's answer and imply a
// preference was recorded when it was not. They are rejected with a precise
// VALIDATION_ERROR instead — making them real needs a schema migration
// (server/store/db.js, A06) and contract text (A05) first; see HANDOFF.
const UNSTORABLE_FIELDS = new Set(['pace', 'availability']);

// ---- parsing helpers --------------------------------------------------------

// Defensive: a corrupt fields_json must never crash GET — treat it as empty.
function parseFields(json) {
  try {
    const value = JSON.parse(json ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function loadSubjects(db, userId) {
  return db.all('SELECT * FROM learner_subjects WHERE user_id = ? ORDER BY LOWER(subject)', userId);
}

// ---- validation (all input is untrusted; clients cannot write 'source') ----

function validateInterests(value) {
  if (!Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'interests must be an array.');
  if (value.length > 12) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 12 interests.');
  return value.map((item, i) => {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > 40) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Interest ${i + 1}: label must be between 1 and 40 characters.`);
    }
    return { label, source: 'stated' }; // client-sent source is stripped
  });
}

function validateGoals(value) {
  if (!Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'goals must be an array.');
  if (value.length > 6) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 6 goals.');
  return value.map((item, i) => {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (label.length < 1 || label.length > 120) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Goal ${i + 1}: label must be between 1 and 120 characters.`);
    }
    const deadline = item?.deadline ?? null;
    if (deadline !== null && (typeof deadline !== 'string' || !DEADLINE_RE.test(deadline))) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Goal ${i + 1}: deadline must be a YYYY-MM-DD date.`);
    }
    return { label, deadline, source: 'stated' }; // client-sent source is stripped
  });
}

function validatePurpose(value) {
  if (value === null) return null;
  if (!PURPOSES.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'purpose must be exam, project, research, deep-understanding, general, or null.');
  }
  return value;
}

function validatePreferences(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'preferences must be an object.');
  }
  // Only explanationStyle can persist. Any other key (pace, availability, a
  // field a later version might add) cannot be stored today, so it is rejected
  // with the field named — never accepted and silently dropped. See
  // UNSTORABLE_FIELDS above for why this is a rejection, not an ignore.
  for (const key of Object.keys(value)) {
    if (key !== 'explanationStyle') {
      throw new ApiError(400, 'VALIDATION_ERROR',
        `preferences.${key} cannot be saved: explanationStyle is the only stored preference. Study pace and availability have no saved field yet — send only the preferences this profile can keep.`);
    }
  }
  const clean = {};
  if (value.explanationStyle !== undefined) {
    const style = typeof value.explanationStyle === 'string' ? value.explanationStyle : value.explanationStyle?.value;
    if (!EXPLANATION_STYLES.has(style)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'explanationStyle must be step-by-step, examples-first, visual, concise, or guided-questions.');
    }
    clean.explanationStyle = { value: style, source: 'stated' };
  }
  return clean;
}

function validateSubjects(value) {
  if (!Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'subjects must be an array.');
  if (value.length > 12) throw new ApiError(400, 'VALIDATION_ERROR', 'Use at most 12 subjects.');
  const clean = new Map(); // subject is the table's primary key — dedupe, last wins
  for (const [i, item] of value.entries()) {
    const subject = typeof item?.subject === 'string' ? item.subject.trim() : '';
    if (subject.length < 1 || subject.length > 60) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Subject ${i + 1}: name must be between 1 and 60 characters.`);
    }
    if (!FAMILIARITIES.has(item?.familiarity)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Subject ${i + 1}: familiarity must be none, basic, familiar, or confident.`);
    }
    const confidence = item?.confidence ?? null;
    if (confidence !== null && (!Number.isInteger(confidence) || confidence < 1 || confidence > 5)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Subject ${i + 1}: confidence must be an integer between 1 and 5.`);
    }
    clean.set(subject, { subject, familiarity: item.familiarity, confidence, source: 'stated' }); // source stripped
  }
  return [...clean.values()];
}

// ---- response shape ---------------------------------------------------------

// The one profile shape served by BOTH /api/profile (GET/PATCH) and
// /api/onboarding/skip, so the two endpoints can never drift apart.
export function profileToApi(row, subjects) {
  if (!row) {
    return {
      state: 'new',
      purpose: null,
      interests: [],
      goals: [],
      preferences: {},
      subjects: [],
      updatedAt: null,
    };
  }
  const fields = parseFields(row.fields_json);
  const preferences = {};
  const style = fields.preferences?.explanationStyle;
  if (style && typeof style === 'object' && EXPLANATION_STYLES.has(style.value)) {
    preferences.explanationStyle = { value: style.value, source: style.source ?? 'stated' };
  }
  return {
    state: row.state,
    purpose: PURPOSES.has(fields.purpose) ? fields.purpose : null,
    interests: Array.isArray(fields.interests) ? fields.interests : [],
    goals: Array.isArray(fields.goals) ? fields.goals : [],
    preferences,
    subjects: subjects.map((s) => ({
      subject: s.subject,
      familiarity: s.familiarity,
      confidence: s.confidence ?? null,
      source: s.source,
    })),
    updatedAt: row.updated_at,
  };
}

export function profileRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.get('/', async (req, res) => {
    const row = await loadProfileRow(db, req.userId);
    // No row yet → a built default. Never insert on GET; state stays "new".
    res.json({ profile: profileToApi(row, row ? await loadSubjects(db, req.userId) : []) });
  });

  // Stated vs inferred, as two labelled buckets. This is the Wave-4
  // stated-vs-inferred preferences surface: an inferred preference (the app's
  // guess) is never presented as something the student declared, because the
  // server itself keeps them in separate blocks.
  //
  // `readLearnerPreferences` (services/personalization.js) is the single
  // provenance reader — a deterministic, read-only pass over the stored row and
  // learner_subjects with NO model call (AGENTS.md: no LLM decides a
  // preference). It is the same function the tutor's learner context uses, so
  // the endpoint and the tutor can never disagree about what is stated.
  //
  // Guarantees: per-user (the verified req.userId selects the row), never a
  // 404 (a fresh user gets empty buckets + hasProfile:false, exactly like
  // GET '/'), and no tokens, keys or internal fields in the response — only
  // the profile the student can see and edit.
  //
  // Confirming an inferred item is a PATCH: PATCH '/'
  // (interests/goals/preferences/subjects) stores everything sent as
  // source:"stated", which moves the item into the stated bucket here.
  router.get('/preferences', async (req, res) => {
    res.json({ preferences: await readLearnerPreferences(db, req.userId) });
  });

  router.patch('/', async (req, res) => {
    const body = req.body ?? {};
    // Reject the known learning preferences the schema cannot store, wherever
    // the client put them, so no field is accepted and silently lost. Checked
    // first so "{ pace: … }" alone gets this precise message rather than the
    // generic "provide at least one of…" below.
    for (const field of UNSTORABLE_FIELDS) {
      if (body[field] !== undefined) {
        throw new ApiError(400, 'VALIDATION_ERROR',
          `"${field}" cannot be saved: the profile has no stored field for it yet, so it is rejected instead of silently dropped. Save interests, goals, purpose, preferences, or subjects.`);
      }
    }
    const keys = ['interests', 'goals', 'purpose', 'preferences', 'subjects'];
    if (!keys.some((key) => body[key] !== undefined)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Provide at least one of: interests, goals, purpose, preferences, subjects.');
    }

    // Validate everything BEFORE writing, so a bad PATCH changes nothing.
    const updates = {};
    if (body.interests !== undefined) updates.interests = validateInterests(body.interests);
    if (body.goals !== undefined) updates.goals = validateGoals(body.goals);
    if (body.purpose !== undefined) updates.purpose = validatePurpose(body.purpose);
    if (body.preferences !== undefined) updates.preferences = validatePreferences(body.preferences);
    if (body.subjects !== undefined) updates.subjects = validateSubjects(body.subjects);

    const row = await loadProfileRow(db, req.userId);
    const fields = parseFields(row?.fields_json);

    // Each provided key replaces that stored value wholesale; omitted keys are
    // left exactly as they were.
    if (updates.interests !== undefined) fields.interests = updates.interests;
    if (updates.goals !== undefined) fields.goals = updates.goals;
    if (updates.purpose !== undefined) fields.purpose = updates.purpose;
    if (updates.preferences !== undefined) fields.preferences = updates.preferences;

    const now = nowIso();
    if (row) {
      await saveProfileRow(db, req.userId, { state: row.state, transcriptJson: row.transcript_json, fieldsJson: JSON.stringify(fields) });
    } else {
      // Manual editing counts as opted out of the intro: state "skipped".
      await saveProfileRow(db, req.userId, { state: 'skipped', transcriptJson: '[]', fieldsJson: JSON.stringify(fields) });
      // First profile write on the hosted engine: give the brand-new account
      // answerable demo material. Prototype mode already seeded at boot.
      if (auth?.mode === 'supabase') {
        void ensureUserSeeded({ db, vector, ai, userId: req.userId }).catch(() => {}); // best effort
      }
    }

    if (updates.subjects !== undefined) {
      // Wholesale replacement: subjects absent from the new list are deleted.
      await db.batch([
        { sql: 'DELETE FROM learner_subjects WHERE user_id = ?', args: [req.userId] },
        ...updates.subjects.map((s) => ({
          sql: 'INSERT INTO learner_subjects (user_id, subject, familiarity, confidence, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          args: [req.userId, s.subject, s.familiarity, s.confidence, s.source, now],
        })),
      ], 'write');
    }

    res.json({ profile: profileToApi(await loadProfileRow(db, req.userId), await loadSubjects(db, req.userId)) });
  });

  router.delete('/', async (req, res) => {
    // Per-user teardown: the profile row, this user's subjects and events.
    // Idempotent like before — deleting when nothing exists is fine.
    await deleteProfileRow(db, req.userId);
    await db.run('DELETE FROM learner_subjects WHERE user_id = ?', req.userId);
    await db.run('DELETE FROM learning_events WHERE user_id = ?', req.userId);
    // 204 with an empty body.
    res.status(204).end();
  });

  return router;
}

// Conversational onboarding endpoints (v1.4): POST /message drives the
// interview one short question at a time; POST /skip opts out at any point.
// Turn logic, model validation and all writes live in services/onboarding.js.
export function onboardingRouter({ db, ai, vector, auth }) {
  const router = express.Router();
  router.use(requireAuth({ auth, db }));

  router.post('/message', async (req, res) => {
    const raw = req.body?.message;
    let message = ''; // null or missing → start the conversation
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'message must be null or a string.');
      }
      message = raw.trim();
      if (message.length < 1 || message.length > 800) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'message must be between 1 and 800 characters.');
      }
    }
    res.json(await turnOnboarding(db, message, { ai, userId: req.userId }));
  });

  router.post('/skip', async (req, res) => {
    const row = await loadProfileRow(db, req.userId);
    if (row?.state === 'completed') {
      throw new ApiError(409, 'ONBOARDING_COMPLETE', 'Onboarding already finished.');
    }
    // Skipping is always reversible (a later /message restarts the interview),
    // so a skipped row is simply written wholesale with a cleared transcript.
    if (row) {
      await saveProfileRow(db, req.userId, { state: 'skipped', transcriptJson: '[]', fieldsJson: row.fields_json });
    } else {
      await saveProfileRow(db, req.userId, { state: 'skipped', transcriptJson: '[]', fieldsJson: '{}' });
      if (auth?.mode === 'supabase') {
        void ensureUserSeeded({ db, vector, ai, userId: req.userId }).catch(() => {});
      }
    }
    res.json({ profile: profileToApi(await loadProfileRow(db, req.userId), await loadSubjects(db, req.userId)) });
  });

  return router;
}
