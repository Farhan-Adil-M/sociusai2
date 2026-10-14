// Deterministic grading — the single source of truth for scoring answers.
//
// NOTHING here calls a language model. The same answer against the same key
// always produces the same score, so every number can be re-checked by hand.
// Three deterministic graders live here:
//
//   gradeAnswers      multiple-choice over stored quiz rows (the quiz routes)
//   gradeMultiSelect  set comparison, optional partial credit
//   gradeShortAnswer  normalised free-text comparison, optional partial credit
//
// Partial-credit rules (stated explicitly — identical on every call):
//   * single-choice MCQ : binary. A wrong OR unanswered (null) choice scores 0.
//   * multi-select      : score = clamp((hits − misses) / |correct set|, 0, 1).
//                         partial:false → 1 only when the selected set equals
//                         the key; otherwise 0.
//   * short answer      : normalised exact (or a listed alternative) → 1;
//                         otherwise, when partial:true, token overlap ≥ 0.5
//                         → 0.5, else 0.
//
// The exported `gradeAnswers` signature and return shape are the contract A17's
// quizService imports; see docs/HANDOFF.md (FROM: A18, TO: A17).

import { ApiError } from '../middleware/errors.js';

export const CHOICE_IDS = Object.freeze(['a', 'b', 'c', 'd']);

export const PARTIAL_CREDIT = Object.freeze({
  shortAnswerMinTokenRatio: 0.5, // token overlap at/above this earns half credit
  shortAnswerAwarded: 0.5, // the half credit itself
});

const round4 = (n) => Number(n.toFixed(4));

/** Strings only, non-empty, de-duplicated — the set primitive both graders use. */
function toIdSet(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return new Set(list.filter((id) => typeof id === 'string' && id !== ''));
}

/**
 * Normalise a short-answer string for comparison: lowercase, straight quotes,
 * punctuation and symbols collapsed to single spaces, whitespace collapsed.
 * `"  The Cell's Nucleus! "` → `"the cell s nucleus"`.
 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Exact multiple-choice match. `null`, an empty string, or an unknown value is
 * never correct (unanswered → incorrect), exactly as the contract requires.
 */
export function gradeChoice(correctChoiceId, choiceId) {
  return typeof choiceId === 'string' && choiceId !== '' && choiceId === correctChoiceId;
}

/**
 * Set-comparison grading for multi-select questions.
 * @returns {{correct: boolean, score: number, partial: boolean, hits: number, misses: number}}
 */
export function gradeMultiSelect(correctIds, selectedIds, { partial = true } = {}) {
  const correct = toIdSet(correctIds);
  const selected = toIdSet(selectedIds);
  const hits = [...selected].filter((id) => correct.has(id)).length;
  const misses = selected.size - hits;
  const exact = hits === correct.size && misses === 0;

  let score = 0;
  if (exact) score = 1;
  else if (partial && correct.size > 0) score = Math.max(0, (hits - misses) / correct.size);

  return { correct: exact, score: round4(score), partial: !exact && score > 0, hits, misses };
}

/**
 * Normalised comparison for short-answer responses.
 * @param {string} expected the key answer
 * @param {string} given the learner's answer
 * @param {{alternatives?: string[], partial?: boolean}} [options]
 * @returns {{correct: boolean, score: number, partial: boolean}}
 */
export function gradeShortAnswer(expected, given, { alternatives = [], partial = false } = {}) {
  const answer = normalizeText(given);
  const target = normalizeText(expected);
  const accepted = [target]
    .concat((Array.isArray(alternatives) ? alternatives : []).map(normalizeText))
    .filter((text) => text !== '');

  if (answer !== '' && accepted.includes(answer)) return { correct: true, score: 1, partial: false };

  if (!partial || target === '' || answer === '') return { correct: false, score: 0, partial: false };

  const expectedTokens = new Set(target.split(' '));
  const givenTokens = new Set(answer.split(' '));
  let shared = 0;
  for (const token of givenTokens) if (expectedTokens.has(token)) shared += 1;
  const ratio = shared / expectedTokens.size;
  const score = ratio >= PARTIAL_CREDIT.shortAnswerMinTokenRatio ? PARTIAL_CREDIT.shortAnswerAwarded : 0;
  return { correct: false, score: round4(score), partial: score > 0 };
}

/** Defensive JSON parse for a stored column: corrupt data must not crash grading. */
function parseArray(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Grade a full multiple-choice attempt against the stored question rows.
 *
 * @param {Array<{idx:number, correct_choice_id:string, explanation?:string, citations_json?:string}>} questionRows
 * @param {Array<{index:number, choiceId:(string|null)}>} answers one entry per question
 * @returns {{correct:number, total:number, partial:boolean, perQuestion:Array<object>}}
 * @throws {ApiError} VALIDATION_ERROR on a missing/invalid/duplicate answer or an
 *   out-of-range index — validated before anything is graded.
 */
export function gradeAnswers(questionRows, answers) {
  if (!Array.isArray(questionRows) || questionRows.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This quiz has no questions to grade.');
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Submit an "answers" array with one entry per question.');
  }

  // Validate every submission before grading anything.
  const seen = new Set();
  for (const answer of answers) {
    if (!answer || !Number.isInteger(answer.index) || answer.index < 0 || answer.index >= questionRows.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Each answer needs a valid question "index".');
    }
    if (seen.has(answer.index)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Question ${answer.index} was answered more than once.`);
    }
    seen.add(answer.index);
    if (answer.choiceId !== null && !CHOICE_IDS.includes(answer.choiceId)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Answer for question ${answer.index} must be one of a, b, c, d or null.`);
    }
  }

  let correct = 0;
  const perQuestion = questionRows.map((question) => {
    const submitted = answers.find((answer) => answer.index === question.idx);
    const yourChoiceId = submitted && submitted.choiceId !== null ? submitted.choiceId : null;
    const isCorrect = gradeChoice(question.correct_choice_id, yourChoiceId);
    if (isCorrect) correct += 1;
    return {
      index: question.idx,
      yourChoiceId,
      correctChoiceId: question.correct_choice_id,
      correct: isCorrect,
      explanation: question.explanation ?? '',
      citations: parseArray(question.citations_json),
    };
  });

  // MCQ is binary — `partial` is always false, present so every grader in this
  // module returns the same result shape.
  return { correct, total: questionRows.length, partial: false, perQuestion };
}
