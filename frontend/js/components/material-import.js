// =============================================================================
// components/material-import.js — the ONE way material enters the app.
//
// Every page that offers "add material" mounts this component; nothing else
// uploads. Keeping it in one file is what stops two upload paths from drifting
// apart (one forgetting a timeout, one forgetting the storage branch).
//
// What it does
//   1. Upload a document (POST /api/sources/upload, or the direct-to-Supabase
//      Storage path when health reports supabase mode) or paste a web page
//      (POST /api/sources/webpage).
//   2. Show an honest in-flight state and surface the SERVER's error code and
//      message verbatim (413 FILE_TOO_LARGE with its limit, 400 UNSUPPORTED_FILE,
//      400 VALIDATION_ERROR, …). The server is the authority on what is allowed.
//   3. After a successful import, either file it into a caller-supplied session
//      (PATCH /api/sources/:id) or ask the backend where it belongs
//      (POST /api/sources/:id/suggest-organization) and let the student accept,
//      override or dismiss the suggestion.
//
// Scope rules mirrored here (docs/API_CONTRACT.md): .pdf/.docx/.pptx documents,
// pasted web text of 50–200 000 chars. Images (.png/.jpg/.jpeg/.webp) are routed
// to POST /api/media/ocr, which is **planned (Wave 4)** — until it exists the
// request fails cleanly and the student gets an honest "not available yet"
// message, never a crash. File size is NOT pre-checked here: MAX_UPLOAD_MB is a
// backend setting, so its 413 is the single authority.
//
// Public interface (documented for other page agents):
//   MIN_WEBPAGE_CHARS, MAX_WEBPAGE_CHARS, DEFAULT_UPLOAD_MB
//   checkUploadFile(file) → string|null
//   checkWebpageInput(url, text) → string|null
//   findDuplicateSource(sources, { fileName?, url? }) → source|null
//   showDuplicateHint(host, matchedSource|null)      (renders into `host`)
//   setUploadLimitHint(el)                            (fills the "up to N MB" line)
//   mountImportPanel({ host, sessionId?, onOrganised?, knownSources? })
//   offerSuggestion(sourceOrId, { host, onOrganised?, sessions? })
//
// Owner: A23. Other agents request changes via docs/HANDOFF.md.
// =============================================================================

import { apiGet, apiPatch, apiPost, apiUpload } from '../api.js';
import { getHealthStatus, storageUploadToStudySources } from '../auth.js';
import { escapeHtml, errorMessage, formatDate, icon, plural } from '../ui.js';

/* ------------------------------------------------------------ validation ---- */

export const MIN_WEBPAGE_CHARS = 50;
export const MAX_WEBPAGE_CHARS = 200000;
export const DEFAULT_UPLOAD_MB = 25;

// Supabase-mode uploads go DIRECTLY into the Storage bucket, so the bucket's
// own limit is the honest number to show (the serverless body cap no longer
// applies). Kept in step with MAX_STORAGE_UPLOAD_MB in server/routes/sources.js.
const STORAGE_UPLOAD_MB = 25;

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const DOC_EXT = /\.(pdf|docx|pptx)$/i;

// The file picker offers documents AND images. `.docx` is included deliberately
// (A08 added DOCX support; see docs/HANDOFF.md).
const ACCEPT = [
  '.pdf', '.docx', '.pptx', '.png', '.jpg', '.jpeg', '.webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png', 'image/jpeg', 'image/webp',
].join(',');

/** True when a file name is an image we would send to the OCR route. */
function isImageFile(name) {
  return IMAGE_EXT.test(String(name ?? ''));
}

/**
 * First problem with a chosen upload file, or null when it may be sent.
 *
 * Deliberately lenient: only an empty file is blocked, because the extension is
 * NOT the authority — a `.pdf` can hold anything and a `.txt` must still get the
 * server's own 400 UNSUPPORTED_FILE answer, which the UI then shows. Blocking
 * other extensions here would hide that answer behind a guessed message.
 */
export function checkUploadFile(file) {
  if (!file || !file.name) return 'Choose a file to upload.';
  if (Number(file.size) === 0) return `«${file.name}» is empty — there is nothing to read.`;
  return null;
}

/** First problem with the pasted-webpage form, or null when valid. */
export function checkWebpageInput(url, text) {
  if (!/^https?:\/\/\S+\.\S+/.test(url)) {
    return 'Enter a full web address, starting with http:// or https://.';
  }
  if (text.length < MIN_WEBPAGE_CHARS) {
    return `Paste at least ${MIN_WEBPAGE_CHARS} characters of page text (currently ${text.length}).`;
  }
  if (text.length > MAX_WEBPAGE_CHARS) {
    return 'That text is too long — 200,000 characters maximum.';
  }
  return null;
}

/* -------------------------------------------------------- duplicate hint ---- */

/**
 * Exact-match duplicate check for the optional import hint (never blocking):
 * files match a source by lowercased/trimmed filename, webpages by exact URL.
 */
export function findDuplicateSource(sources, { fileName = '', url = '' } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  if (fileName) {
    const name = String(fileName).trim().toLowerCase();
    return list.find((source) => String(source?.title || '').trim().toLowerCase() === name) || null;
  }
  if (url) return list.find((source) => (source?.url || '') === url) || null;
  return null;
}

/** Info-only "you already added this" hint. Never blocks an import. */
export function showDuplicateHint(host, matched) {
  if (!host) return;
  if (!matched) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="alert alert-info" role="status">${icon('info', { size: 16 })}
    <div>You already added <strong>${escapeHtml(matched.title || 'this material')}</strong>${matched.createdAt ? ` (${escapeHtml(formatDate(matched.createdAt))})` : ''} — adding it again makes a second copy of the same text.</div></div>`;
}

/* ------------------------------------------------------------ limit hint ---- */

/**
 * Fill an upload-hint element with the real configured limit. Reads the health
 * snapshot auth.js already fetched at boot — no extra network call. Falls back
 * to the markup's default when health is unavailable.
 */
export function setUploadLimitHint(hintEl) {
  if (!hintEl) return;
  const snapshot = getHealthStatus();
  const checks = snapshot && snapshot.ok ? snapshot.data?.checks : null;
  if (!checks) return;
  const viaStorage = checks.auth?.mode === 'supabase';
  const maxMb = viaStorage ? STORAGE_UPLOAD_MB : checks.limits?.maxUploadMb;
  if (Number(maxMb) > 0) {
    hintEl.textContent = `PDF, Word (.docx), PowerPoint (.pptx) or an image — up to ${maxMb} MB.`;
  }
}

/* ------------------------------------------------------------ rendering ----- */

const NOTICE_ICONS = { info: 'info', success: 'checkCircle', warn: 'alert', danger: 'alert' };

/** Replace `host` with a single alert block. `html` is trusted markup. */
function renderNotice(host, variant, html) {
  if (!host) return;
  const kind = NOTICE_ICONS[variant] ? variant : 'info';
  host.innerHTML = `<div class="alert alert-${kind}" role="${kind === 'danger' ? 'alert' : 'status'}">`
    + `${icon(NOTICE_ICONS[kind], { size: 16 })}<div>${html}</div></div>`;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Honest in-flight block. The upload + extraction + embedding is ONE request,
 * so there is no per-byte progress to show through api.js; a determinate
 * percentage would be invented. An indeterminate bar plus the real file name
 * and size is what is actually known.
 */
function busyMarkup(message, title = '') {
  return `<div class="stack-2" role="status" aria-live="polite">
    <div class="cluster-2"><span class="spinner" aria-hidden="true"></span>
      <span class="text-sm">${escapeHtml(message)}</span></div>
    <div class="progress is-indeterminate" role="progressbar" aria-label="Importing material"${title ? ` title="${escapeHtml(title)}"` : ''}><div class="progress-bar"></div></div>
  </div>`;
}

function successMarkup(source, note = '') {
  const title = escapeHtml(source?.title || 'your material');
  const bits = [];
  if (source?.sizeLabel) bits.push(escapeHtml(source.sizeLabel));
  if (Number(source?.chunkCount) > 0) bits.push(plural(source.chunkCount, 'passage'));
  return `<div class="alert alert-success" role="status">${icon('checkCircle', { size: 16 })}
    <div><strong>Added «${title}».</strong>${bits.length ? ` ${bits.join(' · ')}.` : ''}${note ? ` ${escapeHtml(note)}` : ''}</div></div>`;
}

/** Surface a failed import with the server's exact code, never a bare "error". */
function renderUploadError(host, error, { file = null } = {}) {
  if (!host) return;
  if (error?.code === 'OCR_UNAVAILABLE') {
    renderNotice(host, 'info', `<strong>Image import isn’t available yet.</strong> ${escapeHtml(errorMessage(error))}`);
    return;
  }
  const name = file ? `«${escapeHtml(file.name)}»` : 'That file';
  const code = error?.code && error.code !== 'INTERNAL' ? `<p class="text-xs mono">${escapeHtml(error.code)}</p>` : '';
  renderNotice(host, 'danger', `<strong>Could not add ${name}.</strong> ${escapeHtml(errorMessage(error))}${code}`);
}

/* -------------------------------------------------------------- transport --- */

/** Upload a document: direct-to-storage in supabase mode, else multipart. */
async function uploadDocument(file) {
  const checks = getHealthStatus()?.data?.checks;

  if (checks?.auth?.mode === 'supabase' && checks.auth.supabaseUrl) {
    const { storagePath } = await storageUploadToStudySources(file);
    const data = await apiPost('/api/sources/storage-ingest', {
      storagePath,
      title: file.name,
      sizeBytes: file.size,
    });
    return data?.source || null;
  }

  const form = new FormData();
  form.append('file', file);
  const data = await apiUpload('/api/sources/upload', form);
  return data?.source || null;
}

/**
 * Upload an image to the (planned, Wave 4) OCR route. Guarded: when the route
 * is not mounted the request 404s and we translate it into a plain sentence
 * instead of leaking "No route for POST /api/media/ocr".
 */
async function uploadImage(file) {
  const form = new FormData();
  form.append('file', file);
  form.append('ingest', '1');
  try {
    const data = await apiUpload('/api/media/ocr', form);
    return data?.source || null;
  } catch (error) {
    if (error?.code === 'NOT_FOUND' || error?.status === 404) {
      throw Object.assign(
        new Error('Reading text from an image needs OCR, which is not part of this build yet. Add a PDF, Word, PowerPoint or web page instead.'),
        { code: 'OCR_UNAVAILABLE' },
      );
    }
    throw error;
  }
}

/** File a freshly imported source, then report or suggest where it belongs. */
async function placeSource(source, { statusHost, sessionId, onOrganised }) {
  if (!source || !source.id) {
    renderNotice(statusHost, 'warn', 'The material was added, but the server did not return it. Reload the list to see it.');
    onOrganised();
    return;
  }

  if (sessionId) {
    try {
      await apiPatch(`/api/sources/${encodeURIComponent(source.id)}`, { sessionId });
      renderNotice(statusHost, 'success', successMarkup(source, 'Filed in this session.'));
    } catch (error) {
      renderNotice(statusHost, 'warn', `${successMarkup(source)} It could not be filed here (${escapeHtml(errorMessage(error))}) — it is in Unsorted.`);
    }
    onOrganised(source);
    return;
  }

  // Refresh the caller's list straight away so the new material is visible
  // while the (optional, slower) organisation suggestion is being fetched.
  onOrganised(source);
  await offerSuggestion(source, { host: statusHost, onOrganised });
}

/* ----------------------------------------------------------- import panel --- */

/**
 * Render the import panel (document/image upload + web page paste) into `host`.
 * @param {Object} opts
 * @param {HTMLElement} opts.host            where the panel is drawn (a `.card` works well)
 * @param {string|null} [opts.sessionId]     file imports into this session (else Unsorted + AI suggestion)
 * @param {Function}    [opts.onOrganised]   called with the source after any placement change
 * @param {Function}    [opts.knownSources]  () => source[] for the duplicate hint (never blocks)
 */
export function mountImportPanel({
  host,
  sessionId = null,
  onOrganised = () => {},
  knownSources = () => [],
} = {}) {
  if (!host) return;

  host.innerHTML = `
    <div class="stack-4">
      <div class="field">
        <label class="label" for="imp-file">Upload a document or an image</label>
        <input class="input" id="imp-file" type="file" accept="${ACCEPT}">
        <p class="help" data-imp-limit>PDF, Word (.docx), PowerPoint (.pptx) or an image — up to ${DEFAULT_UPLOAD_MB} MB.</p>
      </div>
      <hr class="divider-flush">
      <form class="stack-3" data-imp-webpage novalidate>
        <div class="field">
          <label class="label" for="imp-url">Or paste a web page</label>
          <input class="input" id="imp-url" type="url" inputmode="url" autocomplete="off"
                 placeholder="https://example.org/lesson">
        </div>
        <div class="field">
          <label class="label" for="imp-text">Page text</label>
          <textarea class="textarea" id="imp-text"
                    placeholder="Paste the page text here (at least ${MIN_WEBPAGE_CHARS} characters)"></textarea>
        </div>
        <div><button class="btn btn-secondary" type="submit">Add web page</button></div>
      </form>
      <div data-imp-dup aria-live="polite"></div>
      <div data-imp-status aria-live="polite"></div>
    </div>`;

  const statusHost = host.querySelector('[data-imp-status]');
  const dupHost = host.querySelector('[data-imp-dup]');
  const fileInput = host.querySelector('#imp-file');
  const form = host.querySelector('[data-imp-webpage]');

  setUploadLimitHint(host.querySelector('[data-imp-limit]'));

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    const problem = checkUploadFile(file);
    if (problem) {
      renderNotice(statusHost, 'danger', escapeHtml(problem));
      fileInput.value = '';
      return;
    }

    dupHost.innerHTML = '';
    showDuplicateHint(dupHost, findDuplicateSource(knownSources(), { fileName: file.name }));
    const size = formatBytes(file.size);
    const action = isImageFile(file.name) ? 'Reading the image' : 'Uploading and indexing';
    statusHost.innerHTML = busyMarkup(`${action} «${file.name}»${size ? ` (${size})` : ''}…`, file.name);
    fileInput.value = '';

    try {
      const source = isImageFile(file.name)
        ? await uploadImage(file)
        : await uploadDocument(file);
      await placeSource(source, { statusHost, sessionId, onOrganised });
    } catch (error) {
      renderUploadError(statusHost, error, { file });
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = host.querySelector('#imp-url').value.trim();
    const text = host.querySelector('#imp-text').value.trim();

    const problem = checkWebpageInput(url, text);
    if (problem) {
      renderNotice(statusHost, 'danger', escapeHtml(problem));
      return;
    }

    dupHost.innerHTML = '';
    showDuplicateHint(dupHost, findDuplicateSource(knownSources(), { url }));
    statusHost.innerHTML = busyMarkup('Indexing the page…', url);

    try {
      const data = await apiPost('/api/sources/webpage', { url, text });
      form.reset();
      await placeSource(data?.source, { statusHost, sessionId, onOrganised });
    } catch (error) {
      renderUploadError(statusHost, error);
    }
  });
}

/* -------------------------------------------------------------- suggestion -- */

/** Active study sessions, for the suggestion text and the move dropdown. */
async function loadSessions() {
  try {
    const data = await apiGet('/api/sessions?includeArchived=1');
    return (Array.isArray(data?.sessions) ? data.sessions : []).filter((s) => s.status !== 'archived');
  } catch {
    return [];
  }
}

/**
 * Ask the backend where a freshly imported source belongs and render its
 * suggestion as a recommendation the student can accept, override or dismiss.
 * A failed suggestion never blocks: the import already happened.
 * @param {object|string} source  the source object (or its id)
 * @param {Object} opts
 * @param {HTMLElement} opts.host
 * @param {Function} [opts.onOrganised]
 * @param {Array}    [opts.sessions]  reuse a caller's already-loaded session list
 */
export async function offerSuggestion(source, { host, onOrganised = () => {}, sessions = null } = {}) {
  if (!host) return;
  const sourceId = typeof source === 'string' ? source : source?.id;
  const sourceTitle = typeof source === 'string' ? 'your material' : (source?.title || 'your material');
  if (!sourceId) return;

  let data;
  try {
    data = await apiPost(`/api/sources/${encodeURIComponent(sourceId)}/suggest-organization`, {});
  } catch (error) {
    if (error?.code === 'NIM_ERROR' || error?.code === 'NIM_TIMEOUT') {
      renderNotice(host, 'info', `Added <strong>«${escapeHtml(sourceTitle)}»</strong>. Left in Unsorted — the organiser is unavailable right now. You can file it any time from this page.`);
    } else {
      renderNotice(host, 'info', `Added <strong>«${escapeHtml(sourceTitle)}»</strong>. The organisation check did not run (${escapeHtml(errorMessage(error))}). It is in Unsorted.`);
    }
    onOrganised(source);
    return;
  }

  const list = Array.isArray(sessions) ? sessions : await loadSessions();
  renderSuggestion(host, { sourceId, sourceTitle, data, sessions: list, onOrganised });
}

function moveOptions(sessions) {
  return sessions
    .map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`)
    .join('');
}

function renderSuggestion(host, { sourceId, sourceTitle, data, sessions, onOrganised }) {
  const suggestion = data?.suggestion;
  if (!suggestion) {
    renderNotice(host, 'info', `Added <strong>«${escapeHtml(sourceTitle)}»</strong>. Left in Unsorted — you can file it from this page any time.`);
    return;
  }

  const target = suggestion.matchSessionId
    ? (sessions.find((session) => session.id === suggestion.matchSessionId) || {}).title || 'a session you have'
    : null;
  const newTitle = suggestion.newSession?.title || 'a new session';
  const proposal = target
    ? `Suggested session: <strong>${escapeHtml(target)}</strong>.`
    : `New session: <strong>${escapeHtml(newTitle)}</strong>${suggestion.newSession?.category ? ` · ${escapeHtml(suggestion.newSession.category)}` : ''}.`;
  const acceptLabel = target ? `Move to «${escapeHtml(target)}»` : `Create «${escapeHtml(newTitle)}»`;
  const confidence = suggestion.confidence === 'high'
    ? '<span class="badge badge-success">High confidence</span>'
    : '<span class="badge badge-warn">Low confidence</span>';
  const manualNote = data.applicable === false
    ? '<p class="text-sm muted">You organise this file yourself, so the suggestion is shown for reference only.</p>'
    : '';
  const moveKey = `sug-move-${escapeHtml(sourceId)}`;

  host.innerHTML = `
    <div class="well stack-3">
      <div class="cluster-2">
        <span class="badge badge-info">${icon('spark', { size: 12 })} Suggested</span>
        ${confidence}
      </div>
      <p><strong>Added «${escapeHtml(sourceTitle)}» — file it?</strong></p>
      <p class="text-sm muted">${escapeHtml(suggestion.reason || '')}</p>
      <p>${proposal}</p>
      ${manualNote}
      <div class="cluster-2">
        ${data.applicable === false ? '' : `<button type="button" class="btn btn-primary btn-sm" data-sug-accept>${acceptLabel}</button>`}
        <button type="button" class="btn btn-ghost btn-sm" data-sug-dismiss>Keep in Unsorted</button>
      </div>
      <div class="field">
        <label class="label" for="${moveKey}">Or move it to a session you choose</label>
        <select class="select" id="${moveKey}" data-sug-session>
          <option value="">Choose a session…</option>
          ${moveOptions(sessions)}
        </select>
        <div class="cluster-2"><button type="button" class="btn btn-secondary btn-sm" data-sug-move>Move to this session</button></div>
      </div>
    </div>`;

  wireSuggestion(host, { sourceId, sourceTitle, suggestion, sessions, onOrganised });
}

function wireSuggestion(host, { sourceId, sourceTitle, suggestion, sessions, onOrganised }) {
  const finish = (promise, doneText) => {
    promise.then(
      (data) => {
        renderNotice(host, 'success', `<strong>${escapeHtml(doneText)}</strong> You can move it again any time from this page.`);
        onOrganised(data?.source || { id: sourceId });
      },
      (error) => renderNotice(host, 'danger', `<strong>Could not file «${escapeHtml(sourceTitle)}».</strong> ${escapeHtml(errorMessage(error))}`),
    );
  };

  host.querySelector('[data-sug-accept]')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span> Filing…`;
    finish(
      apiPost(`/api/sources/${encodeURIComponent(sourceId)}/accept-suggestion`, {}),
      suggestion.newSession ? `Created and filed under «${suggestion.newSession.title}».` : 'Filed under the suggested session.',
    );
  });

  host.querySelector('[data-sug-move]')?.addEventListener('click', () => {
    const select = host.querySelector('[data-sug-session]');
    const sessionId = select?.value;
    if (!sessionId) { select?.focus(); return; }
    const title = (sessions.find((session) => session.id === sessionId) || {}).title || 'that session';
    finish(
      apiPatch(`/api/sources/${encodeURIComponent(sourceId)}`, { sessionId }),
      `Moved to «${title}».`,
    );
  });

  host.querySelector('[data-sug-dismiss]')?.addEventListener('click', () => {
    renderNotice(host, 'info', `<strong>Kept in Unsorted.</strong> <strong>«${escapeHtml(sourceTitle)}»</strong> stays unfiled until you move it.`);
    onOrganised();
  });
}
