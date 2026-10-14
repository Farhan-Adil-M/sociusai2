// =============================================================================
// components/session-form.js — the shared "New session" / "Edit session" dialog.
//
// Responsibility: render ONE accessible modal form, validate inputs the way the
// API contract does (title 2–80 chars, category enum, ≤8 tags of 1–24 chars),
// call POST /api/sessions (new) or PATCH /api/sessions/:id (edit) through
// api.js, and resolve with the saved session — or null when the student
// cancels. Server errors are shown inside the dialog.
//
// It is deliberately style-independent: the markup uses only the shared
// classes from components.css (`.modal*`, `.field`, `.label`, `.input`,
// `.select`, `.textarea`, `.error`, `.btn`, `.spinner`), so any page can import
// it without also loading a page stylesheet.
//
// Public interface (used by library.js and the study-session page):
//   CATEGORIES                the fixed category enum [{ value, label }]
//   categoryLabel(value)      human label for a category value
//   openSessionDialog(session?) → Promise<session | null>
//
// Owner: A23. Other agents request changes via docs/HANDOFF.md.
// =============================================================================

import { apiPatch, apiPost } from '../api.js';
import { escapeHtml, errorMessage, icon } from '../ui.js';

/** The contract's fixed category enum, with labels for humans. */
export const CATEGORIES = [
  { value: 'subject', label: 'Subject' },
  { value: 'research', label: 'Research' },
  { value: 'self-study', label: 'Self-study' },
  { value: 'exam-prep', label: 'Exam prep' },
  { value: 'general', label: 'General' },
];

/** Human label for a category value (falls back to the raw value). */
export function categoryLabel(value) {
  const match = CATEGORIES.find((item) => item.value === value);
  return match ? match.label : (value || '');
}

/* --------------------------------------------------------------- overlay ---- */

// One reusable `.modal` element (components.css owns the look; this file owns
// the behaviour: focus in on open, focus back on close, Escape closes, Tab is
// trapped inside the dialog, clicking the backdrop closes).
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]),'
  + ' select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let overlay = null;
let previousFocus = null;
let keyHandler = null;

function buildOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.hidden = true;
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && typeof overlay.onEscape === 'function') overlay.onEscape();
  });
  document.body.appendChild(overlay);
  return overlay;
}

function openOverlay({ html, onEscape }) {
  const node = buildOverlay();
  node.onEscape = onEscape;
  node.innerHTML = `<div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="session-dialog-title">${html}</div>`;
  node.hidden = false;
  previousFocus = document.activeElement;

  keyHandler = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(node.querySelectorAll(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!node.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  const dialog = node.querySelector('.modal-dialog');
  const target = dialog.querySelector('[data-autofocus]') || dialog.querySelector(FOCUSABLE);
  if (target) target.focus();
  return node;
}

function closeOverlay() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  overlay.innerHTML = '';
  overlay.onEscape = null;
  if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
  keyHandler = null;
  if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
  previousFocus = null;
}

/* ------------------------------------------------------------------ form ---- */

function categoryOptions(selected) {
  return CATEGORIES.map((item) => (
    `<option value="${item.value}"${item.value === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`
  )).join('');
}

function formHtml(session) {
  const editing = Boolean(session);
  const saveLabel = editing ? 'Save changes' : 'Create session';
  return `
  <form novalidate>
    <div class="modal-head">
      <h2 class="modal-title" id="session-dialog-title">${editing ? 'Edit study session' : 'New study session'}</h2>
      <button type="button" class="btn btn-ghost btn-icon" data-dlg-close aria-label="Close dialog">${icon('close', { size: 16 })}</button>
    </div>
    <div class="modal-body stack-4">
      <div class="field">
        <label class="label" for="sf-title">Title</label>
        <input class="input" id="sf-title" type="text" maxlength="80" autocomplete="off"
               value="${escapeHtml(session ? session.title : '')}"
               placeholder="e.g. Physics, Research — Black Holes"
               aria-describedby="sf-title-hint" data-autofocus>
        <p class="help" id="sf-title-hint">Between 2 and 80 characters.</p>
      </div>
      <div class="field">
        <label class="label" for="sf-category">Category</label>
        <select class="select" id="sf-category">${categoryOptions(session ? session.category : 'subject')}</select>
      </div>
      <div class="field">
        <label class="label" for="sf-description">Description <span class="muted">(optional)</span></label>
        <textarea class="textarea" id="sf-description" rows="2" maxlength="280"
                  placeholder="What is this session about?">${escapeHtml(session ? session.description || '' : '')}</textarea>
      </div>
      <div class="field">
        <label class="label" for="sf-tags">Tags <span class="muted">(optional)</span></label>
        <input class="input" id="sf-tags" type="text" autocomplete="off"
               value="${escapeHtml(session && session.tags ? session.tags.join(', ') : '')}"
               placeholder="e.g. cells, exam" aria-describedby="sf-tags-hint">
        <p class="help" id="sf-tags-hint">Up to 8 tags, separated by commas.</p>
      </div>
      <p class="error" id="sf-error" role="alert" hidden></p>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
      <button type="submit" class="btn btn-primary" data-save>${saveLabel}</button>
    </div>
  </form>`;
}

/**
 * Open the dialog. Resolves with the saved session object, or null on cancel.
 * @param {object|null} session  existing session to edit, or null to create one
 * @returns {Promise<object|null>}
 */
export function openSessionDialog(session = null) {
  const editing = Boolean(session);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeOverlay();
      resolve(value);
    };

    const node = openOverlay({
      html: formHtml(session),
      onEscape: () => finish(null),
    });

    const form = node.querySelector('form');
    const titleInput = node.querySelector('#sf-title');
    const error = node.querySelector('#sf-error');
    const saveButton = node.querySelector('[data-save]');

    node.querySelector('[data-dlg-close]').addEventListener('click', () => finish(null));
    node.querySelector('[data-cancel]').addEventListener('click', () => finish(null));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;

      const title = titleInput.value.trim();
      if (title.length < 2 || title.length > 80) {
        error.textContent = 'Enter a title between 2 and 80 characters.';
        error.hidden = false;
        titleInput.focus();
        return;
      }

      const category = node.querySelector('#sf-category').value;
      const description = node.querySelector('#sf-description').value.trim();
      const tags = node.querySelector('#sf-tags').value
        .split(',').map((tag) => tag.trim()).filter(Boolean);
      if (tags.length > 8 || tags.some((tag) => tag.length > 24)) {
        error.textContent = 'Use up to 8 tags, each no longer than 24 characters.';
        error.hidden = false;
        return;
      }

      saveButton.disabled = true;
      saveButton.setAttribute('aria-busy', 'true');
      saveButton.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span> Saving\u2026`;
      try {
        const body = { title, category, description, tags };
        const data = editing
          ? await apiPatch(`/api/sessions/${encodeURIComponent(session.id)}`, body)
          : await apiPost('/api/sessions', body);
        finish(data?.session ?? null);
      } catch (err) {
        // Show the server's own message when it sent one.
        error.textContent = errorMessage(err);
        error.hidden = false;
        saveButton.disabled = false;
        saveButton.removeAttribute('aria-busy');
        saveButton.textContent = editing ? 'Save changes' : 'Create session';
      }
    });
  });
}
