// Single source of truth for the enumerations shared between routes and
// services. Adding a value here always flows everywhere (validation, UI
// labels, AI prompt constraints) — previously sessions.js, organizer.js and
// profile.js each kept private copies that silently drifted.

export const CATEGORIES = new Set(['subject', 'research', 'self-study', 'exam-prep', 'general']);
export const PURPOSES = new Set(['exam', 'project', 'research', 'deep-understanding', 'general']);
export const EXPLANATION_STYLES = new Set(['step-by-step', 'examples-first', 'visual', 'concise', 'guided-questions']);
