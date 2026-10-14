// =============================================================================
// components/share.js — the two-way share surface for Socius AI.
//
// This is the ONLY place the app shares content in or out. It is built from
// ui.js + components.css primitives (buttons, alerts, toasts, citations) and
// owns no CSS of its own beyond a few layout hooks in css/share.css.
//
// TWO DIRECTIONS
//   · IN  — mountShareIn(host, opts): a share TARGET / entry point. When the
//            app is opened as an OS share target the payload arrives as URL
//            params (?share=<url>&title=…&text=…) and prefills the form (a
//            Web Share Target; A45 owns the manifest). The same panel is the
//            always-available fallback: a manual paste form. Submitting POSTs
//            to /api/share, which lands the content as a normal source.
//   · OUT — shareResult(payload, opts): share a result (a quiz score, a tutor
//            answer with its citations) to the student's other apps via the
//            Web Share API (navigator.share) when it exists, with an honest
//            copy-to-clipboard fallback otherwise. It NEVER reports "shared"
//            unless the OS share sheet actually completed — a cancelled or
//            unsupported share says so plainly.
//
// ⚠️ SHELL HAZARD: never render into a bare `[data-content]`. mountShell() owns
// that element and moves the page's <main> into it; writing into it erases the
// shell's main column (A30). This component renders ONLY into the `host`
// element a page passes it, using page-prefixed `data-share-*` hooks.
//
// Public interface:
//   mountShareIn(host, { prefill?, onShared?, autoPrefill? }) → controller
//   shareResult({ title, text, url }, { onDone? })  → Promise<{ method, ok, message }>
//   readShareParams(searchString)                  → { url, text, title }
//   webShareAvailable()                             → boolean
//   isHttpUrl(value)                                → boolean
//   SHARE_TITLE_MAX, SHARE_TEXT_MIN, SHARE_TEXT_MAX
// =============================================================================

import { apiPost } from '../api.js';
import { citationEl, escapeHtml, icon, toast } from '../ui.js';

export const SHARE_TITLE_MAX = 160;
export const SHARE_TEXT_MIN = 50;
export const SHARE_TEXT_MAX = 200000;

/** Only a plain http(s) URL is accepted — never javascript: or data:. */
export function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value ?? '').trim());
}

/** True when the browser can open the OS share sheet (navigator.share). */
export function webShareAvailable() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * Read a share-target payload out of a query string. Three aliases for the
 * URL are accepted so an OS share target, the extension, and a hand-written
 * deep link can all reach the same panel. Values are only ever used to
 * prefill inputs — they are validated on submit like anything typed.
 */
export function readShareParams(search = '') {
  const params = new URLSearchParams(search);
  const url = (params.get('share') || params.get('url') || '').trim();
  const text = (params.get('text') || '').trim();
  const title = (params.get('title') || '').trim().slice(0, SHARE_TITLE_MAX);
  return { url, text, title };
}

/* ------------------------------------------------------------ share OUT ---- */

/** Copy text to the clipboard, with a legacy execCommand fallback. */
async function copyToClipboard(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A single plain-text payload a student can paste anywhere. */
export function buildShareText({ title, text, url } = {}) {
  const parts = [];
  if (title) parts.push(String(title).trim());
  if (text) parts.push(String(text).trim());
  if (url && isHttpUrl(url)) parts.push(String(url).trim());
  return parts.join('\n\n');
}

/**
 * Share a result OUT of the app. Uses the Web Share API when present and
 * usable; otherwise copies to the clipboard. Honest about what happened:
 * `method` is 'web-share' | 'clipboard' | 'none', `cancelled` is true when the
 * student dismissed the OS sheet, and `ok` is true only when something was
 * actually shared or copied.
 * @returns {Promise<{method:string, ok:boolean, cancelled?:boolean, message:string}>}
 */
export async function shareResult(payload = {}, { onDone } = {}) {
  const title = String(payload.title ?? '').trim();
  const body = buildShareText(payload);
  const url = isHttpUrl(payload.url) ? String(payload.url).trim() : undefined;

  let result;
  if (body === '' && !url) {
    result = { method: 'none', ok: false, message: 'Nothing to share.' };
  } else if (webShareAvailable() && navigator.canShare?.({ title, text: body, url })) {
    try {
      await navigator.share({ title: title || undefined, text: body || undefined, url });
      result = { method: 'web-share', ok: true, message: 'Shared.' };
    } catch (err) {
      if (err?.name === 'AbortError') {
        result = { method: 'web-share', ok: false, cancelled: true, message: 'Share cancelled.' };
      } else {
        const copied = await copyToClipboard(body || url);
        result = copied
          ? { method: 'clipboard', ok: true, message: 'Share sheet unavailable — copied to your clipboard instead.' }
          : { method: 'none', ok: false, message: 'Could not share. Select the text to copy it manually.' };
      }
    }
  } else {
    const copied = await copyToClipboard(body || url || '');
    result = copied
      ? { method: 'clipboard', ok: true, message: 'Copied to clipboard — you can paste it anywhere.' }
      : { method: 'none', ok: false, message: 'Could not share on this device. Select the text to copy it manually.' };
  }

  if (typeof onDone === 'function') onDone(result);
  return result;
}

/* ------------------------------------------------------------- share IN ---- */

/**
 * Mount the share-IN panel. Renders a small, keyboard-operable form into
 * `host` (never into the shell's [data-content]) and wires it to POST
 * /api/share. Returns a controller ({ open(params), prefill(params), submit() }).
 *
 * @param {HTMLElement} host         page-provided container (a data-share-* node)
 * @param {object}      [options]
 * @param {{url,text,title}} [options.prefill]  initial values
 * @param {boolean}      [options.autoPrefill]  read ?share=… params on mount (default true)
 * @param {(share)=>void}[options.onShared]     called with the 201 {source,share}
 */
export function mountShareIn(host, options = {}) {
  if (!host) throw new Error('mountShareIn needs a host element.');
  const { prefill, autoPrefill = true, onShared } = options;

  const form = document.createElement('form');
  form.className = 'share-in stack-4';
  form.setAttribute('novalidate', '');
  form.innerHTML = `
    <div class="field">
      <label class="label" for="share-in-url">Link</label>
      <input class="input" id="share-in-url" type="url" inputmode="url"
             autocomplete="off" placeholder="https://example.org/lesson" aria-describedby="share-in-url-hint">
      <p class="help" id="share-in-url-hint">A web link, or a direct .pdf / .docx / .pptx file.</p>
    </div>
    <div class="field">
      <label class="label" for="share-in-title">Title <span class="muted">(optional)</span></label>
      <input class="input" id="share-in-title" type="text" autocomplete="off" maxlength="${SHARE_TITLE_MAX}">
    </div>
    <div class="field">
      <label class="label" for="share-in-text">Page text <span class="muted">(optional)</span></label>
      <textarea class="textarea" id="share-in-text" rows="4"
        aria-describedby="share-in-text-hint"
        placeholder="Paste the page text to study exactly what you shared."></textarea>
      <p class="help" id="share-in-text-hint">Needed for a normal web link (${SHARE_TEXT_MIN}-${SHARE_TEXT_MAX.toLocaleString()} characters). Not needed for a .pdf/.docx/.pptx link.</p>
    </div>
    <p class="error" id="share-in-error" role="alert" hidden></p>
    <div class="cluster-2">
      <button type="submit" class="btn btn-primary" data-share-submit>${icon('upload', { size: 16 })}<span>Add to My Materials</span></button>
      <button type="button" class="btn btn-ghost" data-share-clear>Clear</button>
    </div>
    <div class="share-in__status" data-share-status aria-live="polite"></div>
  `;
  host.appendChild(form);

  const urlInput = form.querySelector('#share-in-url');
  const titleInput = form.querySelector('#share-in-title');
  const textInput = form.querySelector('#share-in-text');
  const errorEl = form.querySelector('#share-in-error');
  const statusEl = form.querySelector('[data-share-status]');
  const submitBtn = form.querySelector('[data-share-submit]');
  const clearBtn = form.querySelector('[data-share-clear]');

  const showError = (message, focus) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (focus) focus.focus();
  };
  const clearError = () => { errorEl.hidden = true; errorEl.textContent = ''; };

  // Client-side mirror of the server's rules — server is the authority; this
  // just gives instant, friendly feedback before a round-trip.
  const validate = () => {
    const url = urlInput.value.trim();
    const title = titleInput.value.trim();
    const text = textInput.value.trim();
    if (!isHttpUrl(url)) {
      showError('Enter a full web link starting with http:// or https://.', urlInput);
      return null;
    }
    if (title.length > SHARE_TITLE_MAX) {
      showError(`Keep the title to ${SHARE_TITLE_MAX} characters or fewer.`, titleInput);
      return null;
    }
    const isDoc = /\.(pdf|docx|pptx)(\?|#|$)/i.test(url);
    if (text && (text.length < SHARE_TEXT_MIN || text.length > SHARE_TEXT_MAX)) {
      showError(`Pasted page text must be between ${SHARE_TEXT_MIN} and ${SHARE_TEXT_MAX.toLocaleString()} characters.`, textInput);
      return null;
    }
    if (!isDoc && !text) {
      showError('A normal web link needs the page text pasted below. A direct .pdf/.docx/.pptx link does not.', textInput);
      return null;
    }
    clearError();
    const body = { url };
    if (title) body.title = title;
    if (text) body.text = text;
    return body;
  };

  const setBusy = (busy) => {
    if (busy) {
      submitBtn.dataset.restore = submitBtn.innerHTML;
      submitBtn.setAttribute('aria-busy', 'true');
      submitBtn.setAttribute('aria-disabled', 'true');
      submitBtn.innerHTML = `<span class="spinner spinner-sm" aria-hidden="true"></span><span>Adding…</span>`;
    } else {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.removeAttribute('aria-disabled');
      if (submitBtn.dataset.restore) {
        submitBtn.innerHTML = submitBtn.dataset.restore;
        delete submitBtn.dataset.restore;
      }
    }
  };

  async function submit() {
    const body = validate();
    if (!body) return;
    clearError();
    statusEl.replaceChildren();
    setBusy(true);
    try {
      const data = await apiPost('/api/share', body);
      const source = data && data.source ? data.source : null;
      statusEl.innerHTML = `
        <div class="alert alert-success" role="status">
          ${icon('checkCircle', { size: 16 })}
          <div>
            <strong>Added “${escapeHtml(source?.title ?? 'your link')}”.</strong>
            <p>It is in My Materials and can be organised into a session from there.</p>
          </div>
        </div>
        ${source ? `<div class="citations">${citationEl({ sourceId: source.id, type: source.type, title: source.title, url: source.url, location: null, excerpt: null })}</div>` : ''}`;
      toast('Added to My Materials.', { variant: 'success' });
      form.reset();
      if (typeof onShared === 'function') onShared(data);
    } catch (error) {
      statusEl.innerHTML = `
        <div class="alert alert-danger" role="alert">
          ${icon('alert', { size: 16 })}
          <div><strong>That could not be added.</strong><p>${escapeHtml(error?.message ?? 'Please try again.')}</p></div>
        </div>`;
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  form.querySelector('[data-share-clear]').addEventListener('click', () => {
    clearError();
    statusEl.replaceChildren();
    form.reset();
    urlInput.focus();
  });

  const prefillValues = (values) => {
    if (!values) return;
    if (values.url) urlInput.value = values.url;
    if (values.title) titleInput.value = values.title;
    if (values.text) textInput.value = values.text;
  };
  prefillValues(prefill);
  if (autoPrefill) {
    const fromUrl = readShareParams(typeof window !== 'undefined' ? window.location.search : '');
    if (fromUrl.url) prefillValues(fromUrl);
  }

  return {
    prefill: prefillValues,
    submit,
    focus: () => urlInput.focus(),
  };
}
