// profile.js — the learner-profile page. The profile is fetched once and each
// field (interests, goals, purpose, teaching style, subjects) is an independent
// editor with its own inline editing, validation and error handling. Saving one
// field PATCHes only that top-level key: the contract replaces every provided
// key wholesale, so each save sends the complete edited value.
//
// `source` badges: "stated" → "Your words", "inferred" → "Tutor's guess".
// Inferred items are editable like any other; the server always answers a
// direct edit with source "stated".

import { mountShell, mountHealthBanner } from '../components/shell.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, formatDate, showLoading, showError, errorMessage,
} from '../ui.js';

mountShell('profile');
mountHealthBanner(document.querySelector('[data-health]'));

/**
 * Prefer the redesign's element id, fall back to the pre-redesign hook, so the
 * page keeps working whichever markup generation ships first.
 */
function host(newId, oldSelector) {
  return document.getElementById(newId) || document.querySelector(oldSelector);
}

const aboutHost = host('profileAbout', '[data-about]');
const styleHost = host('profileStyle', '[data-style]');
const subjectsHost = host('profileSubjects', '[data-subjects]');
const stateHost = host('profileStateBanner', '[data-state-banner]');
const dangerStatus = host('profileDangerStatus', '[data-danger-status]');
const live = host('profileLive', '[data-live]');
const fieldHosts = [aboutHost, styleHost, subjectsHost].filter(Boolean);

let profile = null;                 // last state accepted by the server
const editing = {};                 // field name → true while open
const drafts = {};                  // field name → local edit copy
let saving = false;

/* ----------------------------------------------------------- vocabulary */

const PURPOSE_LABELS = {
  exam: 'Exam preparation',
  project: 'Project',
  research: 'Research',
  'deep-understanding': 'Deep understanding',
  general: 'General learning',
};
const STYLE_LABELS = {
  'step-by-step': 'Numbered steps',
  'examples-first': 'Worked examples first',
  visual: 'Plain-picture descriptions',
  concise: 'Short and direct',
  'guided-questions': 'Guide me with questions',
};
const FAMILIARITY_LABELS = { none: 'Not yet', basic: 'Basic', familiar: 'Familiar', confident: 'Confident' };

const FIELD_TITLES = {
  interests: 'Interests', goals: 'Goals', purpose: 'Purpose',
  style: 'Teaching style', subjects: 'Subjects',
};

/* -------------------------------------------------------------- helpers */

/** Badge for where an item came from. Native title = tooltip on hover. */
function sourceBadge(source) {
  const stated = source !== 'inferred';
  const tip = stated
    ? 'You said this — during the intro or by editing it here.'
    : "Guessed by the tutor — you didn't say this.";
  return `
    <span class="badge ${stated ? 'badge-blue' : 'badge-amber'}" title="${escapeHtml(tip)}">
      ${stated ? 'Your words' : `Tutor's guess`}
    </span>`;
}

/** Translated enum value, or the raw value when it is not on the list. */
function enumLabel(labels, value) {
  return labels[value] || value;
}

/** Date input value "2026-01-31" → "31 Jan 2026" in the local day (not UTC). */
function formatDay(value) {
  const parts = String(value).split('-').map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return value;
  return formatDate(new Date(parts[0], parts[1] - 1, parts[2]).toISOString());
}

/** Simple "not told yet" line beneath an unchanged field. */
function notYet() {
  const fresh = profile && profile.state === 'new';
  return fresh
    ? 'Nothing saved yet — take the intro above, or add it here.'
    : 'Not told yet.';
}

/* -------------------------------------------------------- field chrome */

function fieldHead(name, title, hint) {
  return `
    <div class="pf-field-head">
      <div>
        <h3 class="pf-field-title">${escapeHtml(title)}</h3>
        ${hint ? `<p class="field-hint">${escapeHtml(hint)}</p>` : ''}
      </div>
      ${editing[name] ? '' : `
      <button type="button" class="btn btn-secondary btn-sm" data-toggle="${name}">
        ${icon('pencil', { size: 13 })} Edit
      </button>`}
    </div>`;
}

function saveRow(name) {
  return `
    <div class="pf-actions">
      <button type="button" class="btn btn-primary btn-sm" data-save="${name}">Save changes</button>
      <button type="button" class="btn btn-quiet btn-sm" data-toggle="${name}">Cancel</button>
    </div>`;
}

/** One editor block: header + live inline-error slot + editable content. */
function fieldFrame(name, title, hint, body) {
  return `
    <div class="pf-field" data-scope="${name}">
      ${fieldHead(name, title, hint)}
      <p class="field-error" data-err hidden></p>
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

/* ------------------------------------------------------ drafts (edits) */

/** Flatten the stored value of one field into a draft copy for editing. */
function currentValues(name) {
  switch (name) {
    case 'interests':
      return (profile.interests || []).map((item) => ({
        label: item.label, source: item.source,
      }));
    case 'goals':
      return (profile.goals || []).map((item) => ({
        label: item.label, deadline: item.deadline || '', source: item.source,
      }));
    case 'purpose':
      return profile.purpose || '';
    case 'style':
      return (profile.preferences && profile.preferences.explanationStyle)
        ? profile.preferences.explanationStyle.value : '';
    case 'subjects':
      return (profile.subjects || []).map((item) => ({
        subject: item.subject, familiarity: item.familiarity,
        confidence: item.confidence == null ? '' : String(item.confidence),
        source: item.source,
      }));
    default:
      return null;
  }
}

/** Turn a draft into the exact PATCH body — one key per save (wholesale). */
function buildPatch(name) {
  switch (name) {
    case 'interests':
      return { interests: drafts[name].map((item) => ({ label: item.label.trim() })) };
    case 'goals':
      return {
        goals: drafts[name].map((item) => ({
          label: item.label.trim(),
          ...(item.deadline ? { deadline: item.deadline } : {}),
        })),
      };
    case 'purpose':
      return { purpose: drafts[name] || null };
    case 'style':
      return { preferences: { explanationStyle: drafts[name] } };
    case 'subjects':
      return {
        subjects: drafts[name].map((item) => ({
          subject: item.subject.trim(),
          familiarity: item.familiarity,
          ...(item.confidence !== '' ? { confidence: Number(item.confidence) } : {}),
        })),
      };
    default:
      return {};
  }
}

/** Client-side double-check of the contract's rules, before the PATCH. */
const validate = {
  interests() {
    if (drafts.interests.length > 12) return 'At most 12 interests.';
    const bad = drafts.interests.find((item) => item.label.trim().length < 1 || item.label.trim().length > 40);
    return bad ? 'Each interest needs 1–40 characters.' : '';
  },
  goals() {
    if (drafts.goals.length > 6) return 'At most 6 goals.';
    const badLabel = drafts.goals.find((item) => item.label.trim().length < 1 || item.label.trim().length > 120);
    if (badLabel) return 'Each goal needs 1–120 characters.';
    const badDate = drafts.goals.find((item) => item.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(item.deadline));
    return badDate ? 'Target dates must be a valid year-month-day.' : '';
  },
  purpose() { return ''; }, // "—" simply clears the value (null is allowed)
  style() {
    return drafts.style ? '' : 'Choose one of the five styles before saving.';
  },
  subjects() {
    if (drafts.subjects.length > 12) return 'At most 12 subjects.';
    const badName = drafts.subjects.find((item) => item.subject.trim().length < 1 || item.subject.trim().length > 60);
    if (badName) return 'Each subject needs 1–60 characters.';
    const badFam = drafts.subjects.find((item) => !FAMILIARITY_LABELS[item.familiarity]);
    if (badFam) return 'Pick a familiarity level for every subject.';
    const badConf = drafts.subjects.find((item) => {
      if (item.confidence === '') return false;
      const n = Number(item.confidence);
      return !Number.isInteger(n) || n < 1 || n > 5;
    });
    return badConf ? 'Confidence must be a whole number from 1 to 5, or left empty.' : '';
  },
};

/* ------------------------------------------------------ about: interests */

function renderInterests() {
  const name = 'interests';
  const list = editing[name] ? drafts[name] : (profile.interests || []);
  let body;
  if (editing[name]) {
    body = `
      <div class="pf-chips">
        ${list.length === 0
          ? '<span class="field-hint">Nothing added yet — type below to add the first one.</span>'
          : list.map((item, index) => `
            <span class="pf-chip">
              <span>${escapeHtml(item.label)}</span>${sourceBadge(item.source)}
              <button type="button" class="pf-chip-x" title="Remove" aria-label="Remove ${escapeHtml(item.label)}" data-remove-interest="${index}">×</button>
            </span>`).join('')}
      </div>
      <form class="pf-addrow" data-add-interest novalidate>
        <label class="sr-only" for="interest-input">Add an interest</label>
        <input class="input" id="interest-input" maxlength="40" placeholder="e.g. Astronomy" autocomplete="off">
        <button type="submit" class="btn btn-secondary btn-sm">Add</button>
      </form>
      ${saveRow(name)}`;
  } else if (list.length === 0) {
    body = `<p class="pf-none">${notYet()}</p>`;
  } else {
    body = `
      <div class="pf-chips">
        ${list.map((item) => `
          <span class="pf-chip"><span>${escapeHtml(item.label)}</span>${sourceBadge(item.source)}</span>`).join('')}
      </div>`;
  }
  return fieldFrame(name, 'Interests', 'Up to 12, each 1–40 characters.', body);
}

/* ----------------------------------------------------------- about: goals */

function renderGoals() {
  const name = 'goals';
  const list = editing[name] ? drafts[name] : (profile.goals || []);
  let body;
  if (editing[name]) {
    body = `
      <div class="pf-list">
        ${list.length === 0 ? '<p class="pf-none">No goals yet — add the first one below.</p>' : list.map((item, index) => `
          <div class="pf-editor-goal">
            <div class="field">
              <label class="sr-only" for="goal-label-${index}">Goal text</label>
              <input class="input" id="goal-label-${index}" data-goal-label="${index}"
                     maxlength="120" value="${escapeHtml(item.label)}" placeholder="e.g. Pass the biology exam">
            </div>
            <div class="field">
              <label class="sr-only" for="goal-date-${index}">Target date (optional)</label>
              <input class="input" id="goal-date-${index}" type="date" data-goal-date="${index}" value="${escapeHtml(item.deadline)}">
            </div>
            <button type="button" class="pf-remove" data-remove-goal="${index}">Remove</button>
          </div>`).join('')}
      </div>
      <div class="pf-field-toolbar">
        <button type="button" class="btn btn-secondary btn-sm" data-add-goal>${icon('plus', { size: 13 })} Add a goal</button>
        <span class="field-hint">Target date optional · up to 6 goals</span>
      </div>
      ${saveRow(name)}`;
  } else if (list.length === 0) {
    body = `<p class="pf-none">${notYet()}</p>`;
  } else {
    body = `
      <div class="pf-list">
        ${list.map((item) => `
          <div class="pf-row">
            <span class="pf-goal-text">${escapeHtml(item.label)}${
              item.deadline ? ` <span class="field-hint">by ${escapeHtml(formatDay(item.deadline))}</span>` : ''
            }</span>
            ${sourceBadge(item.source)}
          </div>`).join('')}
      </div>`;
  }
  return fieldFrame(name, 'Goals', 'What you are working towards, with an optional finish line.', body);
}

/* --------------------------------------------------------- about: purpose */

function renderPurpose() {
  const name = 'purpose';
  const value = editing[name] ? drafts[name] : (profile.purpose || '');
  let body;
  if (editing[name]) {
    body = `
      <div class="field">
        <label class="field-label" for="purpose-select">What are you learning for?</label>
        <select class="select" id="purpose-select" data-purpose>
          <option value=""${value === '' ? ' selected' : ''}>— not set —</option>
          ${Object.entries(PURPOSE_LABELS).map(([key, label]) =>
            `<option value="${key}"${key === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
        <p class="field-hint">Saves immediately to this one field; "—" clears it.</p>
      </div>
      ${saveRow(name)}`;
  } else if (!value) {
    body = `<p class="pf-none">${notYet()}</p>`;
  } else {
    body = `<p class="pf-goal-text">${escapeHtml(enumLabel(PURPOSE_LABELS, value))}</p>`;
  }
  return fieldFrame(name, 'Purpose', 'One overall reason for learning right now.', body);
}

/* --------------------------------------------------- how to teach (style) */

function renderStyle() {
  const name = 'style';
  const value = editing[name] ? drafts[name]
    : ((profile.preferences && profile.preferences.explanationStyle)
      ? profile.preferences.explanationStyle.value : '');
  const source = (profile.preferences && profile.preferences.explanationStyle)
    ? profile.preferences.explanationStyle.source : '';
  let body;
  if (editing[name]) {
    body = `
      <div class="field">
        <label class="field-label" for="style-select">Preferred explanation style</label>
        <select class="select" id="style-select" data-style-select>
          <option value=""${value === '' ? ' selected' : ''}>— choose a style —</option>
          ${Object.entries(STYLE_LABELS).map(([key, label]) =>
            `<option value="${key}"${key === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
        <p class="field-hint">The tutor also adapts to a single answer in the Study page, without changing this.</p>
      </div>
      ${saveRow(name)}`;
  } else if (!value) {
    body = `<p class="pf-none">${notYet()}</p>`;
  } else {
    body = `<p class="pf-goal-text">${escapeHtml(enumLabel(STYLE_LABELS, value))} ${sourceBadge(source)}</p>`;
  }
  return fieldFrame(name, 'How to teach me', 'The default way the tutor explains new ideas.', body);
}

/* ---------------------------------------------------------- edit: subjects */

function renderSubjects() {
  const name = 'subjects';
  const list = editing[name] ? drafts[name] : (profile.subjects || []);
  let body;
  if (editing[name]) {
    body = `
      <div class="pf-list">
        ${list.length === 0 ? '<p class="pf-none">No subjects yet — add the first one below.</p>' : list.map((item, index) => `
          <div class="pf-editor-subject">
            <div class="field">
              <label class="sr-only" for="subject-name-${index}">Subject name</label>
              <input class="input" id="subject-name-${index}" data-subject-name="${index}"
                     maxlength="60" value="${escapeHtml(item.subject)}" placeholder="e.g. Calculus">
            </div>
            <div class="field">
              <label class="sr-only" for="subject-fam-${index}">Familiarity with ${escapeHtml(item.subject || 'this subject')}</label>
              <select class="select" id="subject-fam-${index}" data-fam="${index}">
                <option value=""${item.familiarity === '' ? ' selected' : ''}>—</option>
                ${Object.entries(FAMILIARITY_LABELS).map(([key, label]) =>
                  `<option value="${key}"${key === item.familiarity ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="sr-only" for="subject-conf-${index}">Confidence 1–5 for ${escapeHtml(item.subject || 'this subject')} (optional)</label>
              <input class="input" id="subject-conf-${index}" data-conf="${index}" type="number" min="1" max="5"
                     step="1" inputmode="numeric" value="${escapeHtml(item.confidence)}" placeholder="1–5">
            </div>
            <button type="button" class="pf-remove" data-remove-subject="${index}">Remove</button>
          </div>`).join('')}
      </div>
      <div class="pf-field-toolbar">
        <button type="button" class="btn btn-secondary btn-sm" data-add-subject>${icon('plus', { size: 13 })} Add a subject</button>
        <span class="field-hint">Familiarity + optional 1–5 confidence · up to 12 subjects</span>
      </div>
      ${saveRow(name)}`;
  } else if (list.length === 0) {
    body = `<p class="pf-none">${notYet()}</p>`;
  } else {
    body = `
      <div class="pf-list">
        ${list.map((item) => `
          <div class="pf-row">
            <span class="pf-goal-text">${escapeHtml(item.subject)}</span>
            <span class="badge">${escapeHtml(enumLabel(FAMILIARITY_LABELS, item.familiarity))}</span>
            ${item.confidence != null ? `<span class="field-hint">confidence ${escapeHtml(String(item.confidence))}/5</span>` : ''}
            ${sourceBadge(item.source)}
          </div>`).join('')}
      </div>`;
  }
  return fieldFrame(name, 'Subjects & familiarity', 'Where you stand in each subject today.', body);
}

/* --------------------------------------------------------------- render */

function renderAll() {
  if (aboutHost) aboutHost.innerHTML = renderInterests() + renderGoals() + renderPurpose();
  if (styleHost) styleHost.innerHTML = renderStyle();
  if (subjectsHost) subjectsHost.innerHTML = renderSubjects();
}

/** Top banner driven by profile.state (new / skipped / completed). */
function renderStateBanner() {
  if (!stateHost) return;
  const state = profile && profile.state;
  if (state === 'completed') { stateHost.hidden = true; return; }
  const skipped = state === 'skipped';
  stateHost.hidden = false;
  stateHost.innerHTML = `
    <div class="banner ${skipped ? 'banner-warn' : 'banner-info'}">${icon(skipped ? 'info' : 'spark', { size: 16 })}
      <span>
        <strong>${skipped ? 'Intro skipped.' : 'Nothing saved yet.'}</strong>
        ${skipped
          ? 'You can fill anything below, or take the intro later.'
          : 'Take a short intro and the tutor drafts a profile for you, or fill this page yourself.'}
      </span>
      <a class="btn btn-secondary btn-sm" href="study.html?onboarding=1">Take the intro</a>
    </div>`;
}

function toggleEdit(name) {
  if (editing[name]) {
    editing[name] = false;
    delete drafts[name];
  } else {
    editing[name] = true;
    drafts[name] = currentValues(name);
  }
  renderAll();
}

/* ------------------------------------------------------------------ save */

async function saveField(name) {
  if (saving || !editing[name]) return;
  const problem = validate[name] && validate[name]();
  if (problem) { showFieldError(name, problem); return; }
  hideFieldError(name);
  saving = true;
  try {
    const data = await api.updateProfile(buildPatch(name));
    profile = data.profile;
    editing[name] = false;
    delete drafts[name];
    renderStateBanner();
    renderAll();
    if (live) live.textContent = `${FIELD_TITLES[name]} saved.`;
  } catch (error) {
    // Server rechecks everything; shown inline under the still-open editor.
    showFieldError(name, errorMessage(error));
  } finally {
    saving = false;
  }
}

/* ------------------------------------------------------------------ load */

async function load() {
  fieldHosts.forEach((node) => showLoading(node, 'Loading your profile…'));
  if (stateHost) stateHost.hidden = true;
  try {
    const data = await api.getProfile();
    profile = data.profile
      || { state: 'new', purpose: null, interests: [], goals: [], preferences: {}, subjects: [] };
    renderStateBanner();
    renderAll();
  } catch (error) {
    fieldHosts.forEach((node) =>
      showError(node, error, { title: 'Could not load your profile', onRetry: load }));
  }
}

/* ---------------------------------------------------------- page events — */

document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) { toggleEdit(toggle.dataset.toggle); return; }

  const save = event.target.closest('[data-save]');
  if (save) { saveField(save.dataset.save); return; }

  const removeInterest = event.target.closest('[data-remove-interest]');
  if (removeInterest) { drafts.interests.splice(Number(removeInterest.dataset.removeInterest), 1); renderAll(); return; }

  const removeGoal = event.target.closest('[data-remove-goal]');
  if (removeGoal) { drafts.goals.splice(Number(removeGoal.dataset.removeGoal), 1); renderAll(); return; }

  const addGoal = event.target.closest('[data-add-goal]');
  if (addGoal) {
    if (drafts.goals.length >= 6) { showFieldError('goals', 'At most 6 goals — remove one first.'); return; }
    drafts.goals.push({ label: '', deadline: '' });
    renderAll();
    focus(`#goal-label-${drafts.goals.length - 1}`);
    return;
  }

  const removeSubject = event.target.closest('[data-remove-subject]');
  if (removeSubject) { drafts.subjects.splice(Number(removeSubject.dataset.removeSubject), 1); renderAll(); return; }

  const addSubject = event.target.closest('[data-add-subject]');
  if (addSubject) {
    if (drafts.subjects.length >= 12) { showFieldError('subjects', 'At most 12 subjects — remove one first.'); return; }
    drafts.subjects.push({ subject: '', familiarity: '', confidence: '' });
    renderAll();
    focus(`#subject-name-${drafts.subjects.length - 1}`);
  }
});

/** Inputs keep their drafts in sync so Save always sends the complete value. */
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset.purpose !== undefined && target.matches('[data-purpose]')) drafts.purpose = target.value;
  else if (target.matches('[data-style-select]')) drafts.style = target.value;
  else if (target.matches('[data-goal-label]')) drafts.goals[Number(target.dataset.goalLabel)].label = target.value;
  else if (target.matches('[data-goal-date]')) drafts.goals[Number(target.dataset.goalDate)].deadline = target.value;
  else if (target.matches('[data-subject-name]')) drafts.subjects[Number(target.dataset.subjectName)].subject = target.value;
  else if (target.matches('[data-fam]')) drafts.subjects[Number(target.dataset.fam)].familiarity = target.value;
  else if (target.matches('[data-conf]')) drafts.subjects[Number(target.dataset.conf)].confidence = target.value;
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-add-interest]');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('input');
  const label = input.value.trim();
  if (!label || label.length > 40) { showFieldError('interests', 'An interest needs 1–40 characters.'); return; }
  if (drafts.interests.length >= 12) { showFieldError('interests', 'At most 12 interests — remove one first.'); return; }
  hideFieldError('interests');
  drafts.interests.push({ label });
  input.value = '';
  renderAll();
  focus('#interest-input');
});

/** Focus after re-render — the re-render wipes and rebuilds the DOM. */
function focus(selector) {
  document.querySelector(selector)?.focus();
}

/* ------------------------------------------------------------ danger zone */

function disarm(button, original) {
  delete button.dataset.armed;
  button.disabled = false;
  button.textContent = original;
}

function wireDanger() {
  const buttons = [...document.querySelectorAll('[data-danger]')];
  buttons.forEach((button) => {
    const original = button.textContent;
    button.addEventListener('click', async () => {
      if (!button.dataset.armed) {
        // First press only arms the button (double-confirm), like deck delete.
        buttons.forEach((other) => {
          if (other !== button) { disarm(other, other.textContent); }
        });
        button.dataset.armed = '1';
        button.textContent = button.dataset.armedLabel || original;
        button.classList.add('pf-armed');
        return;
      }
      button.disabled = true;
      button.textContent = 'Working…';
      if (dangerStatus) dangerStatus.hidden = true;
      try {
        await api.deleteProfile(); // deletes profile + history only, never quizzes
        if (button.dataset.danger === 'restart') {
          window.location.href = 'study.html?onboarding=1'; // Study auto-opens the intro
          return;
        }
        disarm(button, original);
        await load(); // profile returns to state "new" — rerender the page
        if (live) live.textContent = 'Profile deleted. Quizzes, flashcard decks and uploaded material were not touched.';
      } catch (error) {
        disarm(button, original);
        if (dangerStatus) {
          dangerStatus.innerHTML = `${icon('alert', { size: 16 })}
            <span><strong>That did not work.</strong> ${escapeHtml(errorMessage(error))}</span>`;
          dangerStatus.hidden = false;
        }
        if (live) live.textContent = 'The profile action failed.';
      }
    });
  });
}

wireDanger();
load();
