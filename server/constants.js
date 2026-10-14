// Single source of truth for the enumerations shared between routes and
// services. Adding a value here always flows everywhere (validation, UI
// labels, AI prompt constraints) — previously sessions.js, organizer.js and
// profile.js each kept private copies that silently drifted.

export const CATEGORIES = new Set(['subject', 'research', 'self-study', 'exam-prep', 'general']);
export const PURPOSES = new Set(['exam', 'project', 'research', 'deep-understanding', 'general']);
export const EXPLANATION_STYLES = new Set(['step-by-step', 'examples-first', 'visual', 'concise', 'guided-questions']);

/**
 * Trust only the final path segment of a client-supplied filename. A crafted
 * name like "../../etc/passwd.docx", "C:\Windows\evil.docx" or one carrying
 * control characters must never reach a stored title.
 *
 * Lives here rather than in `routes/sources.js` because `services/extract/*`
 * needs the identical logic, and importing a route module from a service would
 * create a circular dependency (sources.js imports the extractors). Written
 * with string operations only so this module keeps zero imports.
 *
 * `fallback` is what an unusable name resolves to ('upload' for documents,
 * 'image' for image ingest) — the behaviour is otherwise identical.
 */
export function sanitizeFilename(name, fallback = 'upload') {
  const slashed = String(name ?? '').replace(/\\/g, '/');
  const base = slashed.slice(slashed.lastIndexOf('/') + 1);
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned === '' || cleaned === '.' || cleaned === '..') ? fallback : cleaned;
}
