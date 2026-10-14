// profile.js — the learner-profile page.
//
// Three jobs, in order of importance:
//
//   1. ACCOUNT   — show who is signed in and in which auth mode. Prototype mode
//                  (a name kept in this browser, no password, no token, no
//                  server account) is labelled unmistakably as NOT a real
//                  account. The real mode is Supabase. No token, JWT or API key
//                  is ever read, logged or rendered here — only a name/email.
//   2. PREFERENCES — the profile the tutor reads. Each field is its own editor
//                  and each save PATCHes only that top-level key, because
//                  PATCH /api/profile replaces every provided key wholesale.
//   3. PROVENANCE — stated vs inferred stays visible. `source: 'inferred'` items
//                  are shown in a separate, clearly-labelled block ("based on
//                  your activity, we think…") and are never presented as
//                  something the student declared. Saving a field turns its
//                  items back into "stated" — that is exactly "confirm".
//
// getAuthMode()/currentUser() are synchronous after mountShell() (which awaits
// requireSignIn → authReady). All network access goes through api.js.

import { mountShell } from '../components/shell.js';
import { apiDelete, apiGet, apiPatch } from '../api.js';
import { currentUser, getAuthMode, signOut } from '../auth.js';
import { errorMessage, errorState, escapeHtml, formatDate, icon, spinner, toast } from '../ui.js';

await mountShell({ page: 'profile' });

const accountHost = document.querySelector('[data-profile-account]');
const contentHost = document.querySelector('[data-profile-content]');
const liveRegion = document.querySelector('[data-profile-live]');

// Boot is finished by now (mountShell awaited it), so both reads are settled.
const AUTH_MODE = getAuthMode(); // 'supabase' | 'prototype'
const USER = currentUser(); // { id, email, name, mode } | null

/* ----------------------------------------------------------- vocabulary -- */

const PURPOSE_LABELS = {
  exam: 'Exam preparation',
  project: 'A project',
  research: 'Research',
  'deep-understanding': 'Deep understanding',
  general: 'General learning',
};

// Must match EXPLANATION_STYLES in server/constants.js exactly.
const STYLE_LABELS = {
  'step-by-step': 'Numbered steps',
  'examples-first': 'Worked examples first',
  visual: 'Plain-picture descriptions',
  concise: 'Short and direct',
  'guided-questions': 'Guide me with questions',
};

// Must match FAMILIARITIES in server/routes/profile.js exactly.
const FAMILIARITY_LABELS = {
  none: 'Not yet',
  basic: 'Basics known',
  familiar: 'Familiar',
  confident: 'Confident',
};

const FIELD_TITLES = {
  interests: 'Interests',
  goals: 'Goals',
  purpose: 'Purpose',
  style: 'Teaching style',
  subjects: 'Subjects',
};

/* ----------------------------------------------------------------- state -- */

let profile = null; // last profile the server accepted
const editing = {}; // field name → true while its editor is open
const drafts = {}; // field name → the local copy being edited
let saving = false; // a PATCH/DELETE is in flight

function blankProfile() {
  return {
    state: 'new', purpose: null, interests: [], goals: [], preferences: {}, subjects: [], updatedAt: null,
  };
}

function announce(message) {
  if (liveRegion) liveRegion.textContent = message;
}

/**
 * Split any list of sourced items into stated vs inferred, using exactly the
 * rule `readLearnerPreferences()` uses server-side (source==='inferred' is the
 * ONLY value that means inferred; everything else is stated). GET /api/profile
 * carries the same `source` field on each item, so the page derives the two
 * buckets from the stored provenance rather than guessing.
 */
function splitBySource(list) {
  const stated = [];
  const inferred = [];
  for (const item of Array.isArray(list) ? list : []) {
    (item?.source === 'inferred' ? inferred : stated).push(item);
  }
  return { stated, inferred };
}

/* --------------------------------------------------------------- account -- */

const PROTO_MESSAGE = 'You are signed in with a name kept only in this browser. '
  + 'There is no password, no token and no server-side account, and the server '
  + 'refuses prototype mode in production. Everything on this page belongs to '
  + 'this one local installation.';

function accountBadge() {
  if (AUTH_MODE === 'supabase') {
    return `<span class="badge badge-success">${icon('check', { size: 12 })} Verified account</span>`;
  }
  if ((USER?.name ?? '').trim()) {
    return `<span class="badge badge-warn">${icon('alert', { size: 12 })} Prototype — not a real account</span>`;
  }
  return '<span class="badge">Signed out</span>';
}

function accountPanelHtml() {
  const name = (USER?.name ?? '').trim();
  const email = (USER?.email ?? '').trim();
  const initial = name ? name.charAt(0).toUpperCase() : '?';

  const identity = `
    <div class="pf-identity">
      <span class="avatar avatar-lg" aria-hidden="true">${escapeHtml(initial)}</span>
      <div class="pf-identity-text">
        <p class="pf-name">${name ? escapeHtml(name) : 'Not signed in'}</p>
        <p class="help">${email
          ? escapeHtml(email)
          : (AUTH_MODE === 'prototype' && name
            ? 'Name-only session (prototype)'
            : 'No account details')}</p>
      </div>
      ${accountBadge()}
    </div>`;

  let note;
  let actions;
  if (AUTH_MODE === 'supabase') {
    note = '<p class="help">Signed in with Supabase — a real, password-protected account. '
      + 'Your profile is stored against this account and is visible only to you.</p>';
    actions = name
      ? `<button type="button" class="btn btn-secondary btn-sm" data-sign-out>${icon('logout', { size: 14 })}<span>Sign out</span></button>`
      : '';
  } else {
    // Prototype mode must never look like a real, verified account.
    note = `<div class="alert alert-warn">${icon('alert', { size: 16 })}
      <div>
        <strong>Prototype mode — this is not a real account.</strong>
        <p>${escapeHtml(PROTO_MESSAGE)}</p>
      </div>
    </div>`;
    actions = name
      ? `<button type="button" class="btn btn-secondary btn-sm" data-sign-out>${icon('logout', { size: 14 })}<span>Sign out</span></button>`
      : `<a class="btn btn-primary btn-sm" href="login.html">${icon('person', { size: 14 })}<span>Sign in</span></a>`;
  }

  return `
    <section class="panel pf-account" aria-labelledby="pf-account-title">
      <div class="panel-head">
        <h2 class="panel-title" id="pf-account-title">Account</h2>
      </div>
      <div class="panel-body stack stack-4 pf-body">
        ${identity}
        ${note}
        ${actions ? `<div class="cluster-2">${actions}</div>` : ''}
      </div>
    </section>`;
}

function renderAccount() {
  if (accountHost) accountHost.innerHTML = accountPanelHtml();
}

/* ------------------------------------------------------- field scaffolding -- */

function fieldHead(name, title, hint) {
  return `
    <div class="pf-field-head">
      <div class="pf-field-titles">
        <h3 class="pf-field-title">${escapeHtml(title)}</h3>
        ${hint ? `<p class="help">${escapeHtml(hint)}</p>` : ''}
      </div>
      ${editing[name] ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-toggle="${name}">${icon('pencil', { size: 13 })} Edit</button>`}
    </div>`;
}

function saveRow(name) {
  return `
    <div class="pf-actions">
      <button type="button" class="btn btn-primary btn-sm" data-save="${name}">${icon('check', { size: 13 })} Save changes</button>
      <button type="button" class="btn btn-ghost btn-sm" data-toggle="${name}">Cancel</button>
    </div>`;
}

/** Header + inline error slot + the field's body, for one preference. */
function fieldFrame(name, title, hint, body) {
  return `
    <div class="pf-field" data-scope="${name}">
      ${fieldHead(name, title, hint)}
      <p class="error" data-err hidden></p>
      ${body}
    </div>`;
}

function showFieldError(name, message) {
  const node = document.querySelector(`[data-scope="${name}"] [data-err]`);
  if (node) { node.textContent = message; node.hidden = false; }
}

function hideFieldError(name) {
  const node = document.querySelector(`[data-scope="${name}"] [data-err]`);
  if (node) { node.textContent = ''; node.hidden = true; }
}

function notYet() {
  return profile && profile.state === 'new'
    ? 'Nothing saved yet — add it below, or set it up by chatting with the tutor.'
    : 'Not set yet.';
}

function guessBadge() {
  return `<span class="badge badge-warn pf-guess-badge">${icon('spark', { size: 11 })} our guess</span>`;
}

/** The explicitly-labelled home for inferred items. Never presented as stated. */
let guessSeq = 0;
function inferredBlock(inner) {
  const titleId = `pf-guess-${(guessSeq += 1)}`;
  return `
    <div class="pf-guess" role="group" aria-labelledby="${titleId}">
      <p class="pf-guess-head" id="${titleId}">${icon('spark', { size: 14 })} Based on your activity, we think</p>
      ${inner}
      <p class="help">We inferred this from how you study — you did not tell us. Open Edit to confirm it
        as your own or remove it.</p>
    </div>`;
}

/** Shown inside an open editor when the draft contains any inferred item. */
function inferredEditorNote(name) {
  const list = drafts[name];
  const hasInferred = Array.isArray(list) && list.some((item) => item.source === 'inferred');
  if (!hasInferred) return '';
  return `<p class="pf-editor-note">${icon('info', { size: 14 })} Items marked “our guess” were inferred from
    your activity. Saving makes everything in this list your own words.</p>`;
}

/* --------------------------------------------------------- drafts & patch -- */

function currentValues(name) {
  switch (name) {
    case 'interests':
      return (profile.interests ?? []).map((item) => ({ label: item.label, source: item.source }));
    case 'goals':
      return (profile.goals ?? []).map((item) => ({
        label: item.label, deadline: item.deadline ?? '', source: item.source,
      }));
    case 'purpose':
      return profile.purpose ?? '';
    case 'style':
      return profile.preferences?.explanationStyle?.value ?? '';
    case 'subjects':
      return (profile.subjects ?? []).map((item) => ({
        subject: item.subject,
        familiarity: item.familiarity ?? '',
        confidence: item.confidence == null ? '' : String(item.confidence),
        source: item.source,
      }));
    default:
      return null;
  }
}

/** The exact PATCH body for one field. The server strips any `source` we send. */
function buildPatch(name) {
  switch (name) {
    case 'interests':
      return { interests: drafts.interests.map((item) => ({ label: item.label.trim() })) };
    case 'goals':
      return {
        goals: drafts.goals.map((item) => ({
          label: item.label.trim(),
          deadline: item.deadline ? item.deadline : null,
        })),
      };
    case 'purpose':
      return { purpose: drafts.purpose || null };
    case 'style':
      // An empty choice clears the saved style: PATCH with `preferences: {}`.
      return drafts.style ? { preferences: { explanationStyle: drafts.style } } : { preferences: {} };
    case 'subjects':
      return {
        subjects: drafts.subjects.map((item) => ({
          subject: item.subject.trim(),
          familiarity: item.familiarity,
          confidence: item.confidence === '' ? null : Number(item.confidence),
        })),
      };
    default:
      return {};
  }
}

// Client-side mirror of the server's rules, so an obvious mistake is caught
// before a round trip. The server remains the authority (it re-validates).
const validators = {
  interests() {
    if (drafts.interests.length > 12) return 'Use at most 12 interests.';
    if (drafts.interests.some((item) => item.label.trim().length < 1 || item.label.trim().length > 40)) {
      return 'Each interest needs between 1 and 40 characters.';
    }
    return '';
  },
  goals() {
    if (drafts.goals.length > 6) return 'Use at most 6 goals.';
    if (drafts.goals.some((item) => item.label.trim().length < 1 || item.label.trim().length > 120)) {
      return 'Each goal needs between 1 and 120 characters.';
    }
    if (drafts.goals.some((item) => item.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(item.deadline))) {
      return 'Each target date must be a valid date.';
    }
    return '';
  },
  purpose() { return ''; }, // an empty choice simply clears it (null is allowed)
  style() { return ''; }, // an empty choice clears the saved style
  subjects() {
    if (drafts.subjects.length > 12) return 'Use at most 12 subjects.';
    if (drafts.subjects.some((item) => item.subject.trim().length < 1 || item.subject.trim().length > 60)) {
      return 'Each subject needs between 1 and 60 characters.';
    }
    if (drafts.subjects.some((item) => !FAMILIARITY_LABELS[item.familiarity])) {
      return 'Pick a familiarity level for every subject.';
    }
    if (drafts.subjects.some((item) => {
      if (item.confidence === '') return false;
      const n = Number(item.confidence);
      return !Number.isInteger(n) || n < 1 || n > 5;
    })) {
      return 'Confidence must be a whole number from 1 to 5, or left empty.';
    }
    return '';
  },
};

/* ------------------------------------------------------- field renderers -- */

function renderInterests() {
  const name = 'interests';
  const list = editing[name] ? drafts[name] : (profile.interests ?? []);
  const hint = 'Up to 12, each 1–40 characters.';

  if (!editing[name]) {
    if (list.length === 0) return fieldFrame(name, FIELD_TITLES[name], hint, `<p class="pf-none">${escapeHtml(notYet())}</p>`);
    const { stated, inferred } = splitBySource(list);
    const chips = (items, guess) => `<div class="pf-chips">${items.map((item) =>
      `<span class="pf-chip${guess ? ' is-guess' : ''}">${escapeHtml(item.label)}${guess ? guessBadge() : ''}</span>`).join('')}</div>`;
    return fieldFrame(name, FIELD_TITLES[name], hint, [
      stated.length ? chips(stated, false) : '',
      inferred.length ? inferredBlock(chips(inferred, true)) : '',
    ].join(''));
  }

  const body = `
    ${list.length === 0
      ? '<p class="pf-none">No interests yet — add the first one below.</p>'
      : `<div class="pf-chips">${list.map((item, index) => `
          <span class="pf-chip${item.source === 'inferred' ? ' is-guess' : ''}">${escapeHtml(item.label)}
            <button type="button" class="chip-remove" data-remove-interest="${index}"
              aria-label="Remove ${escapeHtml(item.label)}" title="Remove">×</button></span>`).join('')}
        </div>`}
    <form class="pf-addrow" data-add-interest novalidate>
      <label class="sr-only" for="pf-interest-input">Add an interest</label>
      <input class="input" id="pf-interest-input" maxlength="40" autocomplete="off" placeholder="e.g. Astronomy">
      <button type="submit" class="btn btn-secondary btn-sm">${icon('plus', { size: 13 })} Add</button>
    </form>
    ${inferredEditorNote(name)}
    ${saveRow(name)}`;
  return fieldFrame(name, FIELD_TITLES[name], hint, body);
}

function renderGoals() {
  const name = 'goals';
  const list = editing[name] ? drafts[name] : (profile.goals ?? []);
  const hint = 'What you are working towards, with an optional finish line.';

  if (!editing[name]) {
    if (list.length === 0) return fieldFrame(name, FIELD_TITLES[name], hint, `<p class="pf-none">${escapeHtml(notYet())}</p>`);
    const { stated, inferred } = splitBySource(list);
    const rows = (items, guess) => `<div class="pf-list">${items.map((item) => `
      <div class="pf-row">
        <span class="pf-row-main">${escapeHtml(item.label)}${item.deadline
          ? ` <span class="help">by ${escapeHtml(formatDate(item.deadline))}</span>` : ''}</span>
        ${guess ? guessBadge() : ''}
      </div>`).join('')}</div>`;
    return fieldFrame(name, FIELD_TITLES[name], hint, [
      stated.length ? rows(stated, false) : '',
      inferred.length ? inferredBlock(rows(inferred, true)) : '',
    ].join(''));
  }

  const editor = `<div class="pf-list">${list.length === 0
    ? '<p class="pf-none">No goals yet — add the first one below.</p>'
    : list.map((item, index) => `
      <div class="pf-editor">
        <div class="field pf-editor-main">
          <label class="sr-only" for="pf-goal-label-${index}">Goal ${index + 1}</label>
          <input class="input" id="pf-goal-label-${index}" data-goal-label="${index}" maxlength="120"
                 value="${escapeHtml(item.label)}" placeholder="e.g. Pass the biology exam">
        </div>
        <div class="field pf-editor-side">
          <label class="sr-only" for="pf-goal-date-${index}">Target date for goal ${index + 1} (optional)</label>
          <input class="input" id="pf-goal-date-${index}" type="date" data-goal-date="${index}"
                 value="${escapeHtml(item.deadline ?? '')}">
        </div>
        <button type="button" class="btn btn-ghost btn-sm pf-remove" data-remove-goal="${index}"
                aria-label="Remove goal ${index + 1}">${icon('trash', { size: 14 })}</button>
      </div>`).join('')}
  </div>`;

  const body = `
    ${editor}
    <div class="pf-field-toolbar">
      <button type="button" class="btn btn-secondary btn-sm" data-add-goal>${icon('plus', { size: 13 })} Add a goal</button>
      <span class="help">Target date optional · up to 6 goals</span>
    </div>
    ${inferredEditorNote(name)}
    ${saveRow(name)}`;
  return fieldFrame(name, FIELD_TITLES[name], hint, body);
}

function renderPurpose() {
  const name = 'purpose';
  const value = editing[name] ? drafts[name] : (profile.purpose ?? '');
  const hint = 'One overall reason for learning right now.';

  if (!editing[name]) {
    const shown = value ? escapeHtml(PURPOSE_LABELS[value] ?? value) : escapeHtml(notYet());
    return fieldFrame(name, FIELD_TITLES[name], hint, `<p class="pf-value">${shown}</p>`);
  }

  const options = Object.entries(PURPOSE_LABELS).map(([key, label]) =>
    `<option value="${key}"${key === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  const body = `
    <div class="field">
      <label class="label" for="pf-purpose-select">What are you learning for?</label>
      <select class="select" id="pf-purpose-select" data-purpose>
        <option value=""${value === '' ? ' selected' : ''}>— not set —</option>
        ${options}
      </select>
      <p class="help">Choosing “not set” clears it.</p>
    </div>
    ${saveRow(name)}`;
  return fieldFrame(name, FIELD_TITLES[name], hint, body);
}

function renderStyle() {
  const name = 'style';
  const pref = profile.preferences?.explanationStyle ?? null;
  const value = editing[name] ? drafts[name] : (pref?.value ?? '');
  const source = pref?.source ?? 'stated';
  const hint = 'The default way the tutor explains new ideas.';

  if (!editing[name]) {
    if (!value) {
      return fieldFrame(name, FIELD_TITLES[name], hint,
        `<p class="pf-none">Not set yet — the tutor will pick a sensible default.</p>`);
    }
    const label = `<p class="pf-value">${escapeHtml(STYLE_LABELS[value] ?? value)}</p>`;
    const body = source === 'inferred' ? inferredBlock(label) : label;
    return fieldFrame(name, FIELD_TITLES[name], hint, body);
  }

  const options = Object.entries(STYLE_LABELS).map(([key, label]) =>
    `<option value="${key}"${key === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
  const note = source === 'inferred'
    ? `<p class="pf-editor-note">${icon('info', { size: 14 })} We guessed “${escapeHtml(STYLE_LABELS[value] ?? value)}”
        from your activity. Saving makes it your own choice.</p>`
    : '';
  const body = `
    <div class="field">
      <label class="label" for="pf-style-select">Preferred explanation style</label>
      <select class="select" id="pf-style-select" data-style>
        <option value=""${value === '' ? ' selected' : ''}>— not set —</option>
        ${options}
      </select>
      <p class="help">Choosing “not set” clears the saved style.</p>
    </div>
    ${note}
    ${saveRow(name)}`;
  return fieldFrame(name, FIELD_TITLES[name], hint, body);
}

function renderSubjects() {
  const name = 'subjects';
  const list = editing[name] ? drafts[name] : (profile.subjects ?? []);
  const hint = 'Where you stand in each subject today.';

  if (!editing[name]) {
    if (list.length === 0) return fieldFrame(name, FIELD_TITLES[name], hint, `<p class="pf-none">${escapeHtml(notYet())}</p>`);
    const { stated, inferred } = splitBySource(list);
    const rows = (items, guess) => `<div class="pf-list">${items.map((item) => `
      <div class="pf-row">
        <span class="pf-row-main">${escapeHtml(item.subject)}</span>
        <span class="badge">${escapeHtml(FAMILIARITY_LABELS[item.familiarity] ?? item.familiarity ?? '—')}</span>
        ${item.confidence != null ? `<span class="help">confidence ${escapeHtml(String(item.confidence))}/5</span>` : ''}
        ${guess ? guessBadge() : ''}
      </div>`).join('')}</div>`;
    return fieldFrame(name, FIELD_TITLES[name], hint, [
      stated.length ? rows(stated, false) : '',
      inferred.length ? inferredBlock(rows(inferred, true)) : '',
    ].join(''));
  }

  const editor = `<div class="pf-list">${list.length === 0
    ? '<p class="pf-none">No subjects yet — add the first one below.</p>'
    : list.map((item, index) => `
      <div class="pf-editor pf-editor-subject">
        <div class="field pf-editor-main">
          <label class="sr-only" for="pf-subject-name-${index}">Subject name</label>
          <input class="input" id="pf-subject-name-${index}" data-subject-name="${index}" maxlength="60"
                 value="${escapeHtml(item.subject)}" placeholder="e.g. Calculus">
        </div>
        <div class="field pf-editor-side">
          <label class="sr-only" for="pf-subject-fam-${index}">Familiarity with ${escapeHtml(item.subject || 'this subject')}</label>
          <select class="select" id="pf-subject-fam-${index}" data-fam="${index}">
            <option value=""${item.familiarity === '' ? ' selected' : ''}>—</option>
            ${Object.entries(FAMILIARITY_LABELS).map(([key, label]) =>
              `<option value="${key}"${key === item.familiarity ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
          </select>
        </div>
        <div class="field pf-editor-conf">
          <label class="sr-only" for="pf-subject-conf-${index}">Confidence 1–5 for ${escapeHtml(item.subject || 'this subject')} (optional)</label>
          <input class="input" id="pf-subject-conf-${index}" data-conf="${index}" type="number" min="1" max="5"
                 step="1" inputmode="numeric" value="${escapeHtml(item.confidence)}" placeholder="1–5">
        </div>
        <button type="button" class="btn btn-ghost btn-sm pf-remove" data-remove-subject="${index}"
                aria-label="Remove subject ${index + 1}">${icon('trash', { size: 14 })}</button>
      </div>`).join('')}
  </div>`;

  const body = `
    ${editor}
    <div class="pf-field-toolbar">
      <button type="button" class="btn btn-secondary btn-sm" data-add-subject>${icon('plus', { size: 13 })} Add a subject</button>
      <span class="help">Familiarity + optional 1–5 confidence · up to 12 subjects</span>
    </div>
    ${inferredEditorNote(name)}
    ${saveRow(name)}`;
  return fieldFrame(name, FIELD_TITLES[name], hint, body);
}

/* ------------------------------------------------------------- sections -- */

function stateBannerHtml() {
  const state = profile?.state;
  if (state !== 'new' && state !== 'in_progress') return ''; // no nagging once done/skipped
  const intro = state === 'in_progress';
  return `
    <div class="alert alert-info pf-alert">
      ${icon(intro ? 'message' : 'spark', { size: 16 })}
      <div>
        <strong>${intro ? 'Your intro is in progress.' : 'Nothing saved yet.'}</strong>
        <p>${intro
          ? 'Finish the chat, or fill anything in below — both work.'
          : 'Set it up by chatting with the tutor, or fill anything in below. The tutor uses it right away.'}</p>
        <p class="pf-alert-action"><a class="btn btn-secondary btn-sm" href="study.html">Open the AI Tutor</a></p>
      </div>
    </div>`;
}

function preferencesHtml() {
  return `
    <section class="panel" aria-labelledby="pf-prefs-title">
      <div class="panel-head">
        <h2 class="panel-title" id="pf-prefs-title">What the tutor knows about you</h2>
        <p class="help pf-legend"><span class="pf-swatch"></span> you told us ·
          <span class="pf-swatch is-guess"></span> we guessed from your activity</p>
      </div>
      <div class="panel-body pf-fields pf-body">
        ${renderGoals()}
        ${renderSubjects()}
        ${renderStyle()}
        ${renderPurpose()}
        ${renderInterests()}
        <div class="pf-note">
          ${icon('info', { size: 16 })}
          <p><strong>Study availability isn’t stored yet.</strong> The profile the server accepts has no
            field for availability or study pace, so this page doesn’t offer one — anything typed for it
            could not be saved. The tutor adapts to your activity instead.</p>
        </div>
      </div>
    </section>`;
}

function privacyHtml() {
  const perUser = AUTH_MODE === 'supabase';
  return `
    <section class="panel" aria-labelledby="pf-privacy-title">
      <div class="panel-head">
        <h2 class="panel-title" id="pf-privacy-title">Where this information lives</h2>
      </div>
      <div class="panel-body stack stack-3 pf-body">
        <p class="help">Your answers — from the intro or typed here — are stored in this app’s database and used
          to personalise your learning: how the tutor explains things, which examples it picks and how hard
          your first quizzes start.</p>
        <p class="help">${perUser
          ? 'This profile is tied to your signed-in account and is visible only to you.'
          : 'This installation has no real accounts, so it keeps one local profile, like the rest of your study data. If the server’s data is reset, the profile goes with it — you can build it again here.'}</p>
      </div>
    </section>`;
}

function dangerHtml() {
  return `
    <section class="panel pf-danger" aria-labelledby="pf-danger-title">
      <div class="panel-head">
        <h2 class="panel-title" id="pf-danger-title">Delete your profile</h2>
      </div>
      <div class="panel-body stack stack-3 pf-body">
        <p class="help">Deletes your saved preferences and the learner-model history built from them. Quizzes,
          flashcard decks and uploaded material are <strong>not</strong> touched.</p>
        <div>
          <button type="button" class="btn btn-danger btn-sm" data-danger="delete"
                  data-armed-label="Click again to confirm.">${icon('trash', { size: 13 })} Delete saved profile</button>
        </div>
        <p class="error" data-danger-error hidden></p>
      </div>
    </section>`;
}

function renderContent() {
  contentHost.innerHTML = [stateBannerHtml(), preferencesHtml(), privacyHtml(), dangerHtml()].join('');
}

function renderAll() {
  renderContent();
}

/* --------------------------------------------------------------- loading -- */

function renderLoading() {
  contentHost.innerHTML = `<section class="panel"><div class="panel-body">${spinner('Loading your profile…')}</div></section>`;
}

async function loadProfile() {
  renderLoading();
  try {
    const data = await apiGet('/api/profile');
    profile = data?.profile ?? blankProfile();
    renderAll();
  } catch (error) {
    contentHost.replaceChildren(errorState(error, loadProfile, { title: 'Could not load your profile' }));
  }
}

/* ------------------------------------------------------------------ edit -- */

function toggleEdit(name) {
  if (editing[name]) {
    editing[name] = false;
    delete drafts[name];
  } else {
    editing[name] = true;
    drafts[name] = currentValues(name);
  }
  renderAll();
  if (editing[name]) {
    const first = document.querySelector(`[data-scope="${name}"] input, [data-scope="${name}"] select`)
      || document.querySelector(`[data-scope="${name}"] button`);
    first?.focus();
  } else {
    document.querySelector(`[data-toggle="${name}"]`)?.focus();
  }
}

function reRenderAndFocus(name, selector) {
  renderAll();
  const target = selector ? document.querySelector(selector) : null;
  if (target) target.focus();
  else document.querySelector(`[data-scope="${name}"] input, [data-scope="${name}"] select`)?.focus();
}

/* ------------------------------------------------------------------ save -- */

function setBusy(name, busy) {
  const button = document.querySelector(`[data-save="${name}"]`);
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.setAttribute('aria-busy', 'true');
  } else {
    button.removeAttribute('aria-busy');
  }
}

async function saveField(name) {
  if (saving || !editing[name]) return;
  const problem = validators[name] ? validators[name]() : '';
  if (problem) {
    showFieldError(name, problem);
    return;
  }
  hideFieldError(name);
  saving = true;
  setBusy(name, true);
  try {
    const data = await apiPatch('/api/profile', buildPatch(name));
    profile = data?.profile ?? profile;
    editing[name] = false;
    delete drafts[name];
    renderAll();
    const title = FIELD_TITLES[name] ?? 'Profile';
    announce(`${title} saved.`);
    toast(`${title} saved.`, { variant: 'success' });
    document.querySelector(`[data-toggle="${name}"]`)?.focus();
  } catch (error) {
    // The server re-checks everything; keep the editor open and show its message.
    showFieldError(name, errorMessage(error));
  } finally {
    saving = false;
    setBusy(name, false);
  }
}

/* ---------------------------------------------------------------- delete -- */

function disarmDanger(button, original) {
  delete button.dataset.armed;
  button.disabled = false;
  button.classList.remove('is-armed');
  button.textContent = original;
}

async function deleteProfile(button, originalText) {
  button.disabled = true;
  button.textContent = 'Deleting…';
  const errorNode = document.querySelector('[data-danger-error]');
  if (errorNode) errorNode.hidden = true;
  try {
    await apiDelete('/api/profile');
    profile = blankProfile();
    renderAll();
    announce('Saved profile deleted.');
    toast('Saved profile deleted.', { variant: 'success' });
  } catch (error) {
    if (errorNode) {
      errorNode.textContent = errorMessage(error);
      errorNode.hidden = false;
    }
    disarmDanger(button, originalText);
  }
}

/* ---------------------------------------------------------------- events -- */

if (accountHost) {
  accountHost.addEventListener('click', (event) => {
    if (event.target.closest('[data-sign-out]')) signOut();
  });
}

if (contentHost) {
  contentHost.addEventListener('click', (event) => {
    const target = event.target;

    const toggle = target.closest('[data-toggle]');
    if (toggle) { toggleEdit(toggle.dataset.toggle); return; }

    const save = target.closest('[data-save]');
    if (save) { saveField(save.dataset.save); return; }

    const removeInterest = target.closest('[data-remove-interest]');
    if (removeInterest) {
      drafts.interests.splice(Number(removeInterest.dataset.removeInterest), 1);
      reRenderAndFocus('interests');
      return;
    }

    const removeGoal = target.closest('[data-remove-goal]');
    if (removeGoal) {
      drafts.goals.splice(Number(removeGoal.dataset.removeGoal), 1);
      reRenderAndFocus('goals');
      return;
    }

    const addGoal = target.closest('[data-add-goal]');
    if (addGoal) {
      if (drafts.goals.length >= 6) { showFieldError('goals', 'Use at most 6 goals — remove one first.'); return; }
      drafts.goals.push({ label: '', deadline: '', source: 'stated' });
      reRenderAndFocus('goals', `#pf-goal-label-${drafts.goals.length - 1}`);
      return;
    }

    const removeSubject = target.closest('[data-remove-subject]');
    if (removeSubject) {
      drafts.subjects.splice(Number(removeSubject.dataset.removeSubject), 1);
      reRenderAndFocus('subjects');
      return;
    }

    const addSubject = target.closest('[data-add-subject]');
    if (addSubject) {
      if (drafts.subjects.length >= 12) { showFieldError('subjects', 'Use at most 12 subjects — remove one first.'); return; }
      drafts.subjects.push({ subject: '', familiarity: '', confidence: '', source: 'stated' });
      reRenderAndFocus('subjects', `#pf-subject-name-${drafts.subjects.length - 1}`);
      return;
    }

    const danger = target.closest('[data-danger]');
    if (danger) {
      const original = danger.textContent;
      if (!danger.dataset.armed) {
        // First press only arms the button (double confirmation).
        document.querySelectorAll('[data-danger]').forEach((other) => {
          if (other !== danger) disarmDanger(other, other.textContent);
        });
        danger.dataset.armed = '1';
        danger.classList.add('is-armed');
        danger.textContent = danger.dataset.armedLabel;
        return;
      }
      deleteProfile(danger, original);
    }
  });

  // Keep drafts in step with the editor. `input` fires as the student types
  // (text, number, date, select in modern browsers); `change` is a fallback.
  const syncDraft = (event) => {
    const el = event.target;
    const { dataset } = el;
    if (!dataset) return;
    if ('purpose' in dataset) drafts.purpose = el.value;
    else if ('style' in dataset) drafts.style = el.value;
    else if ('goalLabel' in dataset) drafts.goals[Number(dataset.goalLabel)].label = el.value;
    else if ('goalDate' in dataset) drafts.goals[Number(dataset.goalDate)].deadline = el.value;
    else if ('subjectName' in dataset) drafts.subjects[Number(dataset.subjectName)].subject = el.value;
    else if ('fam' in dataset) drafts.subjects[Number(dataset.fam)].familiarity = el.value;
    else if ('conf' in dataset) drafts.subjects[Number(dataset.conf)].confidence = el.value;
  };
  contentHost.addEventListener('input', syncDraft);
  contentHost.addEventListener('change', syncDraft);

  contentHost.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-add-interest]');
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector('input');
    const label = input.value.trim();
    if (!label || label.length > 40) { showFieldError('interests', 'An interest needs between 1 and 40 characters.'); return; }
    if (drafts.interests.length >= 12) { showFieldError('interests', 'Use at most 12 interests — remove one first.'); return; }
    hideFieldError('interests');
    drafts.interests.push({ label, source: 'stated' });
    input.value = '';
    reRenderAndFocus('interests', '#pf-interest-input');
  });
}

/* ------------------------------------------------------------------ boot -- */

renderAccount();
loadProfile();
