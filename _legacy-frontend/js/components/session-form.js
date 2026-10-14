// components/session-form.js — the shared "New session" / "Edit session"
// dialog used by the Study Library and the Session page.
//
// Responsibility: render an accessible form dialog, validate inputs the way
// the API contract does (title 2–80 chars, category enum, ≤8 tags of 1–24
// chars), call POST or PATCH /api/sessions, and resolve with the saved
// session — or null when the student cancels. Errors from the API's error
// envelope are shown inside the dialog. One dialog element is reused.

import { api } from '../api.js';
import { icon, escapeHtml, errorMessage } from '../ui.js';

/** The contract's fixed category enum, with labels for humans. */
export const CATEGORIES = [
  { value: 'subject', label: 'Subject' },
  { value: 'research', label: 'Research' },
  { value: 'self-study', label: 'Self-study' },
  { value: 'exam-prep', label: 'Exam prep' },
  { value: 'general', label: 'General' },
];

export function categoryLabel(value) {
  const match = CATEGORIES.find((item) => item.value === value);
  return match ? match.label : (value || '');
}

let dialog = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'dlg';
  dialog.setAttribute('aria-labelledby', 'session-dialog-title');
  document.body.appendChild(dialog);
  return dialog;
}

function categoryOptions(selected) {
  return CATEGORIES.map((item) =>
    `<option value="${item.value}"${item.value === selected ? ' selected' : ''}>${item.label}</option>`).join('');
}

function formHtml(session) {
  const editing = Boolean(session);
  const saveLabel = editing ? 'Save changes' : 'Create session';
  return `
    <form class="dlg-form" novalidate>
      <div class="dlg-head">
        <h2 id="session-dialog-title">${editing ? 'Edit session' : 'New session'}</h2>
        <button type="button" class="btn btn-quiet btn-sm dlg-close" aria-label="Close dialog">${icon('close', { size: 16 })}</button>
      </div>
      <div class="dlg-body stack stack-4">
        <div class="field">
          <label class="field-label" for="sf-title">Title</label>
          <input class="input" id="sf-title" type="text" maxlength="80" required
                 value="${escapeHtml(session ? session.title : '')}"
                 placeholder="e.g. Physics, Research — Black Holes"
                 aria-describedby="sf-title-hint">
          <p class="field-hint" id="sf-title-hint">Between 2 and 80 characters.</p>
        </div>
        <div class="field">
          <label class="field-label" for="sf-category">Category</label>
          <select class="select" id="sf-category">${categoryOptions(session ? session.category : 'subject')}</select>
        </div>
        <div class="field">
          <label class="field-label" for="sf-description">Description <span class="muted">(optional)</span></label>
          <textarea class="textarea" id="sf-description" rows="2" maxlength="280"
                    placeholder="What is this session about?">${escapeHtml(session ? session.description || '' : '')}</textarea>
        </div>
        <div class="field">
          <label class="field-label" for="sf-tags">Tags <span class="muted">(optional)</span></label>
          <input class="input" id="sf-tags" type="text"
                 value="${escapeHtml(session && session.tags ? session.tags.join(', ') : '')}"
                 placeholder="e.g. cells, exam" aria-describedby="sf-tags-hint">
          <p class="field-hint" id="sf-tags-hint">Up to 8 tags, separated by commas.</p>
        </div>
        <p class="field-error" id="sf-error" role="alert" hidden></p>
      </div>
      <div class="dlg-actions">
        <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
        <button type="submit" class="btn btn-primary" data-save>${saveLabel}</button>
      </div>
    </form>`;
}

/**
 * Open the dialog. Resolves with the saved session object, or null on cancel.
 * @param {object|null} session  existing session to edit, or null to create
 */
export function openSessionDialog(session = null) {
  const node = ensureDialog();
  node.innerHTML = formHtml(session);
  node.showModal();

  const form = node.querySelector('form');
  const titleInput = node.querySelector('#sf-title');
  const error = node.querySelector('#sf-error');
  const saveButton = node.querySelector('[data-save]');
  const editing = Boolean(session);

  const close = () => { try { node.close(); } catch { /* already closed */ } };
  node.querySelector('.dlg-close').addEventListener('click', close);
  node.querySelector('[data-cancel]').addEventListener('click', close);
  titleInput.focus();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { settled = true; close(); resolve(value); };

    // ESC or clicking the backdrop closes the dialog → treat as cancel.
    node.addEventListener('close', () => { if (!settled) resolve(null); }, { once: true });

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
      saveButton.innerHTML = '<span class="spinner" aria-hidden="true"></span> Saving…';
      try {
        const data = editing
          ? await api.updateSession(session.id, { title, category, description, tags })
          : await api.createSession({ title, category, description, tags });
        finish(data.session);
      } catch (err) {
        // Show the server's own validation message when it sent one.
        error.textContent = errorMessage(err);
        error.hidden = false;
        saveButton.disabled = false;
        saveButton.textContent = editing ? 'Save changes' : 'Create session';
      }
    });
  });
}
