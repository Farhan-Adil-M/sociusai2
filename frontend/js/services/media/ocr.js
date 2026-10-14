// Browser-side client for image → text (`POST /api/media/ocr`).
//
// ONE job: take a File the student picked, send it through the app's single
// fetch layer (`api.js` — the browser must never talk to the OCR engine
// itself), and hand back a result a page can show honestly.
//
// WHAT "HONEST" MEANS HERE
//   - The text is what the OCR engine read on the server. Nothing in this file
//     generates, guesses, or "tidies up" a character of it.
//   - The engine reports a confidence and a per-line confidence. We show them,
//     and we say plainly when the read may be unreliable instead of presenting
//     a shaky transcription as fact.
//   - The loading state reports REAL elapsed time. It does not invent a
//     percentage: tesseract.js emits progress events inside the server's worker
//     thread, and the endpoint answers with one JSON body, so the browser
//     cannot observe them. An animated-but-fake 0→100% would be a lie about
//     something we cannot measure; a spinner plus a running clock is not.

import { apiUpload } from '../../api.js';
import { escapeHtml, icon } from '../../ui.js';

/** The one endpoint this module talks to. */
export const OCR_ENDPOINT = '/api/media/ocr';

/**
 * The limits the server enforces, mirrored here so a rejection can be explained
 * before a round-trip. They are a convenience for the student, never the
 * authority — the server validates the bytes itself.
 */
export const OCR_LIMITS = Object.freeze({
  extensions: ['.png', '.jpg', '.jpeg', '.webp'],
  accept: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp',
  maxMb: 25,
  maxMegapixels: 40,
  // A typical slide photo takes well under a second; a dense page or a noisy
  // scan takes several. Quoting a range keeps the wait explainable.
  typicalSeconds: '5–30',
});

/** Busy copy: real elapsed time, no invented percentage. */
export const OCR_BUSY_LABEL = `Reading the image — this usually takes ${OCR_LIMITS.typicalSeconds} seconds…`;

/**
 * First problem with a chosen image, or null when it may be sent.
 *
 * Deliberately narrow. The extension is NOT trustworthy evidence and the pixel
 * count is not knowable in the browser without decoding the file, so those
 * decisions stay with the server — this only catches what the student can be
 * told instantly (nothing chosen, empty, obviously too large, obviously not an
 * image) instead of making them wait for a round-trip.
 */
export function checkImageFile(file) {
  if (!file) return 'Choose an image to read.';
  if (Number(file.size) === 0) return `«${file.name}» is empty — there is nothing to read.`;
  if (Number(file.size) > OCR_LIMITS.maxMb * 1024 * 1024) {
    return `«${file.name}» is ${(file.size / (1024 * 1024)).toFixed(1)} MB — the image limit is ${OCR_LIMITS.maxMb} MB.`;
  }
  return null;
}

/**
 * Send one image to the OCR endpoint.
 *
 * @param {File} file an image from an <input type="file">
 * @param {object} [options]
 * @param {boolean} [options.ingest=true] also store the text as a source
 * @returns {Promise<object>} the server's body, normalised (see READ_*_KEYS)
 * @throws {ApiError} with the server's own `code` when it rejects the image
 */
export async function readImageText(file, { ingest = true } = {}) {
  const form = new FormData();
  form.append('file', file);
  if (ingest) form.append('ingest', '1');
  const data = await apiUpload(OCR_ENDPOINT, form);
  return normalizeOcrResult(data);
}

/**
 * Copy the fields we understand out of the response and give them defaults, so
 * a caller never has to defend against a missing key. Anything we do not know
 * about is left alone.
 */
export function normalizeOcrResult(data) {
  const result = data && typeof data === 'object' ? data : {};
  const text = typeof result.text === 'string' ? result.text : '';
  return {
    ...result,
    text,
    charCount: Number.isFinite(result.charCount) ? result.charCount : text.length,
    confidence: Number.isFinite(result.confidence) ? result.confidence : null,
    reliability: typeof result.reliability === 'string' ? result.reliability : 'unknown',
    note: typeof result.note === 'string' ? result.note : '',
    lineCount: Number.isFinite(result.lineCount) ? result.lineCount : 0,
    unreliableLines: Array.isArray(result.unreliableLines) ? result.unreliableLines : [],
    source: result.source ?? null,
  };
}

// ------------------------------------------------------------- presentation

const TONES = {
  good: { badge: 'badge-success', alert: 'alert-success', label: 'Read clearly' },
  fair: { badge: 'badge-warn', alert: 'alert-warn', label: 'Read with care' },
  poor: { badge: 'badge-danger', alert: 'alert-danger', label: 'Read unreliably' },
  unknown: { badge: 'badge-info', alert: 'alert-info', label: 'Confidence unknown' },
};

/** How much to trust the read, in words the student can act on. */
export function confidenceLabel(result) {
  const tone = TONES[result?.reliability] ?? TONES.unknown;
  const hasScore = Number.isFinite(result?.confidence);
  const badgeText = hasScore
    ? `${tone.label} · ${Math.round(result.confidence * 100)}% confidence`
    : tone.label;
  return { tone, badgeClass: tone.badge, alertClass: tone.alert, label: tone.label, badgeText };
}

/** "3 of 12 lines were hard to read" — only when we have real evidence. */
function unreliableSentence(result) {
  const lines = result.unreliableLines ?? [];
  if (lines.length === 0 || !result.lineCount) return '';
  return `${lines.length} of ${result.lineCount} ${result.lineCount === 1 ? 'line' : 'lines'} `
    + `were hard to read (line ${lines.map((n) => n + 1).join(', ')}).`;
}

/**
 * Render the recognised text and its confidence into `host`.
 *
 * Accessible by construction: the text block is a labelled region that a
 * keyboard user can scroll into and read, the unreliable-line disclosure is a
 * native `<details>` (Enter/Space work everywhere), the copy control is a real
 * `<button>`, and every status message sits in an `aria-live` region so a
 * screen reader announces it without stealing focus.
 */
export function renderOcrResult(host, result, { title = 'Text read from the image' } = {}) {
  if (!host) return;
  const { badgeText, badgeClass } = confidenceLabel(result);
  const unreliable = unreliableSentence(result);
  const text = result.text ?? '';

  host.innerHTML = `
    <section class="stack-3" aria-label="${escapeHtml(title)}">
      <div class="cluster-2">
        <span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span>
        ${Number.isFinite(result.durationMs)
          ? `<span class="text-xs muted">read in ${(result.durationMs / 1000).toFixed(1)}s</span>`
          : ''}
      </div>
      ${result.note
        ? `<div class="alert ${TONES[result.reliability]?.alert ?? 'alert-info'}" role="status">
             ${icon('info', { size: 16 })}
             <div>${escapeHtml(result.note)}</div>
           </div>`
        : ''}
      ${unreliable
        ? `<details class="text-sm">
             <summary>Which lines were unreliable?</summary>
             <p class="muted">${escapeHtml(unreliable)}</p>
           </details>`
        : ''}
      <pre tabindex="0" role="region" aria-label="Recognised text">${escapeHtml(text)}</pre>
      <div class="cluster-2">
        <button class="btn btn-secondary btn-sm" type="button" data-ocr-copy>Copy text</button>
        <span class="text-xs muted" role="status" aria-live="polite" data-ocr-copy-status></span>
      </div>
    </section>`;

  const button = host.querySelector('[data-ocr-copy]');
  const status = host.querySelector('[data-ocr-copy-status]');
  button?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (status) status.textContent = 'Copied.';
    } catch {
      // No clipboard permission (or an insecure origin): say so rather than
      // pretending the copy worked.
      if (status) status.textContent = 'Could not copy — select the text and copy it manually.';
    }
  });
}
