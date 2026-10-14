// =============================================================================
// components/scope-select.js — fills a "Search in" dropdown from GET /api/sources.
//
// Responsibility: turn the user's material list into <option>s (plus an
// optional availability note). It does NOT manage the selection — the caller
// reads the select's value. It never calls fetch directly: data comes from
// api.js, which handles auth, the error envelope and mock mode.
//
// This is the ONE source-picker used by the quiz, flashcard and study pages,
// so scope rules cannot drift between them.
//
// Public interface:
//   populateScopeSelect(select, note?, { sessionId? })
//     → Promise<source[]>  (the sources that were loaded; [] on failure)
//   "All material" always stays the first, empty-valued option, so a caller's
//   default of "search everything" keeps working when the list fails to load.
//
// Owner: A23. Other agents request changes via docs/HANDOFF.md.
// =============================================================================

import { apiGet } from '../api.js';
import { escapeHtml, plural } from '../ui.js';

/** The always-present first option, so a failed load still searches everything. */
const ALL_MATERIAL_OPTION = '<option value="">All material</option>';

/**
 * @param {HTMLSelectElement} select  filled with "<option value=''>All material</option>" + one per source
 * @param {HTMLElement|null}   note    receives a short availability sentence
 * @param {Object}             [options]
 * @param {string|null}        [options.sessionId]  scope the list to one session
 * @returns {Promise<Array>} the sources that were loaded (empty on failure)
 */
export async function populateScopeSelect(select, note = null, { sessionId = null } = {}) {
  if (!select) return [];
  const path = sessionId
    ? `/api/sources?sessionId=${encodeURIComponent(sessionId)}`
    : '/api/sources';

  try {
    const data = await apiGet(path);
    const sources = Array.isArray(data?.sources) ? data.sources : [];
    select.innerHTML = ALL_MATERIAL_OPTION
      + sources.map((source) => (
        `<option value="${escapeHtml(source.id)}">${escapeHtml(source.title || 'Untitled source')}</option>`
      )).join('');
    if (note) {
      note.textContent = sources.length
        ? `${plural(sources.length, 'source')} available`
        : 'No sources yet — add material in My Materials first.';
    }
    return sources;
  } catch {
    // Keep the safe default ("All material") so the caller still works.
    select.innerHTML = ALL_MATERIAL_OPTION;
    if (note) note.textContent = 'Source list unavailable — questions will search all your material.';
    return [];
  }
}
