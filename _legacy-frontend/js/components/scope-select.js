// components/scope-select.js — fills the "Search in" dropdown used by the
// Flashcards and Quiz generators from GET /api/sources.
//
// Responsibility: turn the source list into select options and an optional
// availability note. It does not manage selection — callers read the value.

import { api } from '../api.js';
import { escapeHtml } from '../ui.js';

/**
 * @param {HTMLSelectElement} select  filled with "<option value=''>All material</option>" + one per source
 * @param {HTMLElement|null}   note   receives a short availability sentence
 * @param {Object}             options  optional { sessionId } to scope the list to one session
 * @returns {Promise<Array>} the sources that were loaded (empty on failure)
 */
export async function populateScopeSelect(select, note = null, { sessionId = null } = {}) {
  try {
    const data = await api.listSources(sessionId ? { sessionId } : {});
    const sources = data.sources || [];
    select.innerHTML = '<option value="">All material</option>' + sources
      .map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.title)}</option>`)
      .join('');
    if (note) {
      note.textContent = sources.length
        ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'} available`
        : 'No sources yet';
    }
    return sources;
  } catch {
    if (note) note.textContent = 'Source list unavailable — questions will search all material.';
    return [];
  }
}
