// =============================================================================
// pages/quiz.js — the Assessments screen.
//
// Responsibility: let a student generate a source-grounded assessment from
// their own material, answer it one question at a time, and understand the
// result. It renders into the content slot the shell gives it and reads/writes
// through api.js only (never fetch, never the model directly).
//
// Boundaries this file respects:
//   · Grading happens on the server (server/services/grading.js). This page
//     only displays the numbers the server returned — it never computes a
//     score and presents it as authoritative.
//   · The answer key never reaches this page before submission; the generate
//     response carries no correctChoiceId/explanation.
//   · Every model-written string (question text, choices, explanations) and
//     every server string is escaped or rendered through ui.js helpers before
//     it reaches innerHTML.
//
// States: idle → loading → quiz / submitting → results, plus empty (no
// material → CTA) and error + retry. A repeat submission returns
// 409 QUIZ_ALREADY_ANSWERED with the stored result under error.result, which is
// rendered as "already submitted — here are your results", never as a failure.
// =============================================================================

import { mountShell } from '../components/shell.js';
import { apiGet, apiPost } from '../api.js';
import {
  escapeHtml,
  icon,
  spinner,
  emptyState,
  errorState,
  citationEl,
  markdownLite,
  plural,
  errorMessage,
} from '../ui.js';

/* ----------------------------------------------------------------- config -- */

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// The 1–4 level scale (docs/API_CONTRACT.md v2.0). The wording describes the
// QUESTION — never the student's ability. The backend's prompt uses
// "recall / application / analysis" language, so these descriptors match it.
const LEVEL_INFO = {
  1: { label: 'Recall', hint: 'asks you to remember a fact from the material' },
  2: { label: 'Understanding', hint: 'asks you to explain how or why something works' },
  3: { label: 'Application', hint: 'asks you to use an idea in a new situation' },
  4: { label: 'Analysis', hint: 'asks you to weigh several ideas against each other' },
};

const TOPIC_MIN = 2;
const TOPIC_MAX = 80;

/* ------------------------------------------------------------------- DOM --- */

const stage = document.querySelector('[data-stage]');
const live = document.querySelector('[data-live]');
const form = document.querySelector('[data-generate-form]');
const topicInput = document.querySelector('#qz-topic');
const topicError = document.querySelector('#qz-topic-error');
const countSelect = document.querySelector('#qz-count');
const scopeNote = document.querySelector('[data-scope-note]');
const generateButton = document.querySelector('[data-generate]');

/* --------------------------------------------------------------- URL input -- */

const search = new URLSearchParams(window.location.search);
const presetTopic = (search.get('topic') || '').trim();
const presetSessionId = (search.get('session') || '').trim();

/* ------------------------------------------------------------------ state -- */

const state = {
  phase: 'idle', // idle | loading | error | quiz | submitting | results
  session: null, // { id, title } when ?session=… scopes the quiz
  materialCount: null, // number | null (unknown)
  quiz: null, // the generate response's quiz object
  answers: [], // choiceId | null, one per question
  index: 0,
  result: null, // the server's result object (also on the 409 replay)
  alreadyAnswered: false, // true when the result came from a 409
  shortfall: false, // model produced fewer questions than requested
  warning: false, // the "unanswered questions" warning is showing
  error: null, // generation failure
  submitError: null, // submission failure
  lastParams: null, // for retry
  focusQuestion: false, // focus the question heading after the next render
};

/* --------------------------------------------------------------- utilities -- */

function announce(message) {
  if (live) live.textContent = String(message ?? '');
}

function levelBadge(level) {
  const value = Number(level);
  if (!Number.isInteger(value) || value < 1 || value > 4) return '';
  const info = LEVEL_INFO[value];
  const title = `Question difficulty level ${value} of 4 — this question ${info.hint}. It describes the question, not you.`;
  return `<span class="qz-level" data-level="${value}" title="${escapeHtml(title)}">`
    + `<span class="qz-level-num">L${value}</span>`
    + `<span class="qz-level-label">${escapeHtml(info.label)}</span></span>`;
}

function minuteLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isInteger(value) || value < 1) return '';
  return `<span class="qz-minutes">${icon('clock', { size: 13 })}<span>${escapeHtml(plural(value, 'min'))}</span></span>`;
}

function choiceText(question, choiceId) {
  if (choiceId == null || !question) return null;
  const choice = (question.choices || []).find((item) => item.id === choiceId);
  return choice ? choice.text : null;
}

/** A short, honest read of the score. No false praise. */
function verdictFor(percent) {
  if (percent >= 80) return 'Strong result — the next assessment will step up.';
  if (percent >= 50) return 'Solid work. Keep building on this topic.';
  return 'Worth another pass — review the explanations, then try again.';
}

/* ------------------------------------------------------------- setup panel -- */

function topicProblem(topic) {
  if (topic.length < TOPIC_MIN) return 'Enter a topic — at least 2 characters.';
  if (topic.length > TOPIC_MAX) return `Keep the topic under ${TOPIC_MAX} characters.`;
  return '';
}

function showTopicError(message) {
  if (!topicError || !topicInput) return;
  topicError.textContent = message;
  topicError.hidden = !message;
  topicInput.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function renderSetup() {
  if (!scopeNote) return;
  if (state.session) {
    scopeNote.textContent = `Scope: ${state.session.title || 'this study session'}`;
  } else if (state.materialCount === 0) {
    scopeNote.textContent = 'No material yet';
  } else {
    scopeNote.textContent = 'All of your material';
  }
}

/* ----------------------------------------------------------------- verbs ---- */

function setGenerating(busy) {
  if (!generateButton) return;
  generateButton.disabled = busy;
  generateButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  generateButton.innerHTML = busy
    ? `<span class="spinner spinner-sm" aria-hidden="true"></span> Writing questions…`
    : 'Start assessment';
}

async function loadContext() {
  try {
    const data = await apiGet('/api/sources');
    state.materialCount = Array.isArray(data.sources) ? data.sources.length : 0;
  } catch {
    state.materialCount = null; // unknown — never block generating on this
  }

  if (presetSessionId) {
    try {
      const data = await apiGet(`/api/sessions/${encodeURIComponent(presetSessionId)}`);
      state.session = data.session || { id: presetSessionId, title: null };
    } catch {
      // A session we cannot read still scopes the request server-side; the
      // error, if any, surfaces on generate. Keep the id, drop the title.
      state.session = { id: presetSessionId, title: null };
    }
  }
}

async function startQuiz(params) {
  state.lastParams = params;
  state.phase = 'loading';
  state.error = null;
  setGenerating(true);
  render();
  announce('Writing questions from your material.');

  try {
    const data = await apiPost('/api/quiz/generate', params);
    const quiz = data && data.quiz;
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      throw Object.assign(new Error('No questions came back. Try a different topic.'), {
        code: 'QUIZ_CONTENT_INVALID',
      });
    }

    state.quiz = quiz;
    state.answers = new Array(quiz.questions.length).fill(null);
    state.index = 0;
    state.result = null;
    state.alreadyAnswered = false;
    state.submitError = null;
    state.warning = false;
    state.shortfall = quiz.questions.length < params.questionCount;
    state.phase = 'quiz';
    state.focusQuestion = true;
    render();
    announce(`Assessment ready: ${plural(quiz.questions.length, 'question')}.`);
  } catch (error) {
    state.phase = 'error';
    state.error = error;
    render();
    announce(errorMessage(error));
  } finally {
    setGenerating(false);
  }
}

function goTo(index) {
  const total = state.quiz ? state.quiz.questions.length : 0;
  if (index < 0 || index >= total) return;
  state.index = index;
  state.focusQuestion = true;
  render();
  announce(`Question ${index + 1} of ${total}.`);
}

function goToNextUnanswered() {
  const total = state.answers.length;
  for (let step = 1; step <= total; step += 1) {
    const candidate = (state.index + step) % total;
    if (state.answers[candidate] === null) {
      goTo(candidate);
      return;
    }
  }
}

function clearWarning() {
  if (!state.warning) return;
  state.warning = false;
  const node = stage ? stage.querySelector('[data-warning]') : null;
  if (node) node.remove();
}

/** Update the progress bar, labels and navigator without re-rendering. */
function refreshAnsweredUI() {
  const total = state.answers.length;
  const answered = state.answers.filter((answer) => answer !== null).length;

  const bar = stage.querySelector('[data-progress-bar]');
  if (bar) bar.style.width = `${total ? Math.round((answered / total) * 100) : 0}%`;

  const progress = stage.querySelector('[data-progress]');
  if (progress) progress.setAttribute('aria-valuenow', String(answered));

  const answeredLabel = stage.querySelector('[data-answered-label]');
  if (answeredLabel) answeredLabel.textContent = `${answered} of ${total} answered`;

  const unansweredLabel = stage.querySelector('[data-unanswered-label]');
  if (unansweredLabel) {
    const left = total - answered;
    unansweredLabel.textContent = left > 0 ? `${left} unanswered` : 'All answered';
  }

  stage.querySelectorAll('[data-nav-btn]').forEach((button) => {
    const index = Number(button.dataset.navBtn);
    button.classList.toggle('is-answered', state.answers[index] !== null);
  });

  clearWarning();
}

function requestSubmit() {
  const unanswered = state.answers.filter((answer) => answer === null).length;
  if (unanswered > 0 && !state.warning) {
    state.warning = true;
    render();
    announce(`${plural(unanswered, 'question')} unanswered. Answer them, or submit as-is.`);
    return;
  }
  submitQuiz();
}

async function submitQuiz() {
  if (state.phase === 'submitting' || !state.quiz) return;
  state.phase = 'submitting';
  state.submitError = null;
  state.warning = false;
  render();
  announce('Submitting your answers.');

  const answers = state.answers.map((choiceId, index) => ({ index, choiceId }));

  try {
    const data = await apiPost(`/api/quiz/${encodeURIComponent(state.quiz.id)}/answer`, { answers });
    if (!data || !data.result) {
      throw Object.assign(new Error('The server did not return a result.'), { code: 'INTERNAL' });
    }
    applyResult(data.result, false);
  } catch (error) {
    // Idempotency (docs/API_CONTRACT.md): a repeat submission returns 409
    // QUIZ_ALREADY_ANSWERED with the ORIGINAL result under error.result. That
    // is a successful outcome for the student — show their stored results.
    const stored = error && error.data && error.data.result;
    if (error && error.code === 'QUIZ_ALREADY_ANSWERED' && stored) {
      applyResult(stored, true);
      return;
    }
    state.phase = 'quiz';
    state.submitError = error;
    render();
    announce(`Could not submit: ${errorMessage(error)}`);
  }
}

function applyResult(result, alreadyAnswered) {
  state.result = result;
  state.alreadyAnswered = Boolean(alreadyAnswered);
  state.phase = 'results';
  state.submitError = null;
  state.warning = false;
  render();
  announce(alreadyAnswered
    ? 'This assessment was already submitted. Showing your stored results.'
    : `Submitted. Score ${result.score ? result.score.percent : 0} percent.`);
}

function resetToIdle() {
  state.phase = 'idle';
  state.quiz = null;
  state.answers = [];
  state.index = 0;
  state.result = null;
  state.alreadyAnswered = false;
  state.shortfall = false;
  state.warning = false;
  state.submitError = null;
  state.error = null;
  state.focusQuestion = false;
  render();
  if (topicInput) topicInput.focus();
}

/* ------------------------------------------------------------------ render -- */

function render() {
  renderSetup();
  renderStage();
}

function renderStage() {
  if (!stage) return;

  if (state.phase === 'loading') {
    stage.innerHTML = loadingHtml();
    return;
  }
  if (state.phase === 'error') {
    const code = state.error && state.error.code;
    // A content problem is best met with "add material / try again", not a bare
    // error box. A transient infrastructure failure (vector store, provider)
    // keeps errorState's plain retry instead.
    if (code === 'QUIZ_CONTENT_INVALID' || code === 'SESSION_EMPTY') {
      stage.innerHTML = noMaterialHtml(state.error);
      return;
    }
    stage.replaceChildren(errorState(state.error, () => startQuiz(state.lastParams), {
      title: 'Could not write the assessment',
    }));
    return;
  }
  if (state.phase === 'results') {
    stage.innerHTML = resultsHtml();
    afterRenderResults();
    return;
  }
  if (state.phase === 'quiz' || state.phase === 'submitting') {
    stage.innerHTML = quizHtml();
    afterRenderQuiz();
    return;
  }
  stage.innerHTML = idleHtml();
}

/* -------------------------------------------------------------- sub-render -- */

function loadingHtml() {
  return `<div class="panel qz-loading">
    <div class="panel-body stack-4">
      ${spinner('Writing questions from your material…')}
      <div class="progress is-indeterminate" aria-hidden="true"><div class="progress-bar"></div></div>
      <p class="muted text-sm">Socius AI is reading your material and checking every question against it. This usually takes a few seconds.</p>
    </div>
  </div>`;
}

function idleHtml() {
  if (state.materialCount === 0) {
    return `<div class="panel"><div class="panel-body">
      ${emptyState({
        icon: 'folder',
        title: 'No material yet',
        body: 'Assessments are written from your own material. Upload a file or add a web page first — then generate your first assessment.',
        action: `<a class="btn btn-primary" href="library.html">${icon('upload', { size: 16 })} Add material</a>`,
      })}
    </div></div>`;
  }
  return `<div class="panel"><div class="panel-body">
    ${emptyState({
      icon: 'clipboard',
      title: 'No assessment yet',
      body: 'Pick a topic and a difficulty above, then start. Questions come from your material, and nothing is scored until you submit.',
    })}
  </div></div>`;
}

function noMaterialHtml(error) {
  const title = error && error.code === 'SESSION_EMPTY'
    ? 'This study session has no material'
    : 'Not enough material on that topic';
  return `<div class="panel"><div class="panel-body">
    ${emptyState({
      icon: 'search',
      title,
      body: errorMessage(error),
      action: `<a class="btn btn-primary" href="library.html">Add material</a>
        <button type="button" class="btn btn-secondary" data-retry-generate>${icon('refresh', { size: 16 })} Try again</button>`,
    })}
  </div></div>`;
}

function noticeAlerts() {
  const parts = [];

  if (state.shortfall) {
    const made = state.quiz.questions.length;
    const asked = state.lastParams ? state.lastParams.questionCount : made;
    parts.push(`<div class="alert alert-info qz-notice">${icon('info', { size: 18 })}
      <span>You asked for ${escapeHtml(plural(asked, 'question'))}, but only ${escapeHtml(plural(made, 'question'))} could be written without repeating ones you have already seen on this topic.</span></div>`);
  }

  if (state.quiz.weakEvidence) {
    parts.push(`<div class="alert alert-warn qz-notice">${icon('alert', { size: 18 })}
      <span>The material on this topic is thin, so these questions may be less grounded. Adding more material will help.</span></div>`);
  }

  if (state.submitError) {
    parts.push(`<div class="alert alert-danger qz-notice">${icon('alert', { size: 18 })}
      <div><strong>Could not submit the assessment.</strong> ${escapeHtml(errorMessage(state.submitError))}
        <div class="cluster cluster-2 qz-notice-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-submit>Try submitting again</button>
        </div>
      </div></div>`);
  }

  if (state.warning) {
    const unanswered = state.answers.filter((answer) => answer === null).length;
    parts.push(`<div class="alert alert-warn qz-notice" data-warning>${icon('alert', { size: 18 })}
      <div><strong>${escapeHtml(plural(unanswered, 'question'))} ${unanswered === 1 ? 'is' : 'are'} still unanswered.</strong>
        Unanswered questions count as wrong.
        <div class="cluster cluster-2 qz-notice-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-answer-unanswered>Show an unanswered question</button>
          <button type="button" class="btn btn-primary btn-sm" data-submit-anyway>Submit anyway</button>
        </div>
      </div></div>`);
  }

  return parts.join('');
}

function optionHtml(question, choice) {
  const checked = state.answers[state.index] === choice.id;
  return `<label class="qz-option">
    <input class="qz-option-input" type="radio" name="qz-choice" value="${escapeHtml(choice.id)}" ${checked ? 'checked' : ''}>
    <span class="qz-option-key" aria-hidden="true">${escapeHtml(String(choice.id).toUpperCase())}</span>
    <span class="qz-option-text">${escapeHtml(choice.text)}</span>
    <span class="qz-option-mark" aria-hidden="true">${icon('check', { size: 16 })}</span>
  </label>`;
}

function navButtonHtml(index) {
  const answered = state.answers[index] !== null;
  const current = index === state.index;
  return `<button type="button" class="qz-nav-btn${answered ? ' is-answered' : ''}"
    data-nav-btn="${index}" ${current ? 'aria-current="true"' : ''}
    aria-label="Question ${index + 1} of ${state.answers.length}${answered ? ', answered' : ', not answered'}">${index + 1}</button>`;
}

function quizHtml() {
  const quiz = state.quiz;
  const total = quiz.questions.length;
  const question = quiz.questions[state.index];
  const answered = state.answers.filter((answer) => answer !== null).length;
  const percent = total ? Math.round((answered / total) * 100) : 0;
  const submitting = state.phase === 'submitting';

  return `<article class="qz-quiz" aria-labelledby="qz-question-title">
    <header class="qz-quiz-head">
      <div class="qz-quiz-meta">
        <h2 class="qz-topic">${escapeHtml(quiz.topic)}</h2>
        <div class="cluster cluster-2">
          <span class="badge">${escapeHtml(DIFFICULTY_LABELS[quiz.difficulty] || 'Mixed')}</span>
          ${levelBadge(question.difficulty)}
          ${minuteLabel(question.estimatedMinutes)}
        </div>
        <p class="qz-level-note">Difficulty describes the question, not you. Level 1–4 is the question's own level.</p>
      </div>
      <p class="qz-counter">Question <strong>${state.index + 1}</strong><span> of ${total}</span></p>
    </header>

    <div class="qz-progress-block">
      <div class="progress-label">
        <span data-answered-label>${answered} of ${total} answered</span>
        <span data-unanswered-label>${total - answered > 0 ? `${total - answered} unanswered` : 'All answered'}</span>
      </div>
      <div class="progress" data-progress role="progressbar" aria-valuemin="0" aria-valuemax="${total}"
           aria-valuenow="${answered}" aria-label="Questions answered">
        <div class="progress-bar" data-progress-bar style="width:${percent}%"></div>
      </div>
    </div>

    ${noticeAlerts()}

    <fieldset class="qz-question">
      <legend class="sr-only">Choose one answer</legend>
      <p class="qz-question-num">Question ${state.index + 1}</p>
      <h3 class="qz-question-text" id="qz-question-title" tabindex="-1">${escapeHtml(question.text)}</h3>
      <div class="qz-options">
        ${question.choices.map((choice) => optionHtml(question, choice)).join('')}
      </div>
    </fieldset>

    <nav class="qz-nav" aria-label="Jump to a question">
      ${quiz.questions.map((_item, index) => navButtonHtml(index)).join('')}
    </nav>

    <div class="qz-actions">
      <button type="button" class="btn btn-secondary" data-prev ${state.index === 0 || submitting ? 'disabled' : ''}>
        ${icon('chevronLeft', { size: 15 })} Previous
      </button>
      <button type="button" class="btn btn-secondary" data-next ${state.index >= total - 1 || submitting ? 'disabled' : ''}>
        Next ${icon('chevronRight', { size: 15 })}
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" data-submit ${submitting ? 'disabled aria-busy="true"' : ''}>
        ${submitting ? '<span class="spinner spinner-sm" aria-hidden="true"></span> Submitting…' : 'Submit assessment'}
      </button>
    </div>
  </article>`;
}

function masteryHtml(mastery, recommendedDifficulty, displayTopic) {
  if (!mastery) return '';
  const afterPct = Math.round((mastery.after ?? 0) * 100);
  const hasBefore = mastery.before !== null && mastery.before !== undefined;
  const beforePct = hasBefore ? Math.round(mastery.before * 100) : null;
  const deltaPct = typeof mastery.delta === 'number'
    ? Math.round(mastery.delta * 100)
    : (hasBefore ? afterPct - beforePct : 0);

  // mastery.topic is the server's lower-cased key; prefer the capitalisation
  // the student typed (the quiz's own topic) when we still have it.
  const topic = displayTopic || mastery.topic;

  let note;
  if (!hasBefore) {
    note = `This is your first graded attempt on <strong>${escapeHtml(topic)}</strong>, so mastery starts at ${afterPct}%.`;
  } else if (deltaPct > 0) {
    note = `Mastery rose ${deltaPct} point${deltaPct === 1 ? '' : 's'} this attempt.`;
  } else if (deltaPct < 0) {
    note = `Mastery dropped ${Math.abs(deltaPct)} point${Math.abs(deltaPct) === 1 ? '' : 's'} this attempt.`;
  } else {
    note = 'Mastery is unchanged this attempt.';
  }
  if (recommendedDifficulty) {
    const word = DIFFICULTY_LABELS[recommendedDifficulty] || recommendedDifficulty;
    note += ` Your next assessment on this topic will be <strong>${escapeHtml(word)}</strong>.`;
  }

  const value = hasBefore ? `${beforePct}% → ${afterPct}%` : `${afterPct}%`;

  return `<div class="qz-mastery well">
    <div class="progress-label">
      <span>Topic mastery</span>
      <strong>${value}</strong>
    </div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"
         aria-valuenow="${afterPct}" aria-label="Topic mastery ${afterPct} percent">
      <div class="progress-bar" style="width:${afterPct}%"></div>
    </div>
    <p class="qz-mastery-note">${note}</p>
  </div>`;
}

function reviewItemHtml(item, questions) {
  const question = questions[item.index] || null;
  const text = question ? question.text : `Question ${item.index + 1}`;
  const yourText = choiceText(question, item.yourChoiceId);
  const correctText = choiceText(question, item.correctChoiceId);
  const correct = item.correct;

  return `<article class="qz-review-item ${correct ? 'is-correct' : 'is-incorrect'}">
    <header class="qz-review-head">
      <span class="qz-verdict-badge ${correct ? 'is-correct' : 'is-incorrect'}">
        ${icon(correct ? 'checkCircle' : 'close', { size: 14 })}
        <span>${correct ? 'Correct' : 'Incorrect'}</span>
      </span>
      <span class="qz-review-index">Question ${item.index + 1}</span>
      ${question ? levelBadge(question.difficulty) : ''}
    </header>
    <p class="qz-review-question">${escapeHtml(text)}</p>
    <div class="qz-answers">
      <p class="qz-answer ${correct ? 'is-correct' : 'is-incorrect'}">
        <span class="qz-answer-label">Your answer</span>
        <span class="qz-answer-value">${yourText ? escapeHtml(yourText) : '<em>No answer given</em>'}</span>
      </p>
      ${correct ? '' : `<p class="qz-answer is-correct">
        <span class="qz-answer-label">Correct answer</span>
        <span class="qz-answer-value">${escapeHtml(correctText || '—')}</span>
      </p>`}
    </div>
    ${item.explanation ? `<div class="qz-explanation">
      <p class="qz-explanation-label">Why</p>
      <div class="prose">${markdownLite(item.explanation)}</div>
    </div>` : ''}
    ${Array.isArray(item.citations) && item.citations.length ? `<div class="qz-citations">
      <p class="qz-citations-label">From your sources</p>
      <div class="citations">${item.citations.map((cite) => citationEl(cite)).join('')}</div>
    </div>` : ''}
  </article>`;
}

function resultsHtml() {
  const result = state.result;
  const score = result.score || { correct: 0, total: 0, percent: 0 };
  const mastery = result.masteryUpdate || null;
  const quiz = state.quiz;
  const questions = quiz ? quiz.questions : [];
  const topic = quiz ? quiz.topic : (mastery ? mastery.topic : 'Assessment');

  const notice = state.alreadyAnswered
    ? `<div class="alert alert-info qz-notice" id="qz-result-lead" tabindex="-1">${icon('info', { size: 18 })}
        <span><strong>This assessment was already submitted.</strong> These are the results from that submission — the score has not changed, and it was not graded twice.</span></div>`
    : '';

  return `<article class="qz-result stack-5">
    ${notice}
    <header class="qz-score-card">
      <div class="qz-score-figure" role="img" aria-label="${score.percent} percent, ${score.correct} of ${score.total} correct">
        <span class="qz-score-value">${score.percent}%</span>
        <span class="qz-score-caption">${score.correct} of ${score.total} correct</span>
      </div>
      <div class="qz-score-body stack-3">
        <div>
          <p class="eyebrow">Result</p>
          <h2 id="qz-result-title" tabindex="-1">${escapeHtml(topic)}</h2>
        </div>
        <p class="qz-verdict">${escapeHtml(verdictFor(score.percent))}</p>
        ${masteryHtml(mastery, result.recommendedDifficulty, topic)}
      </div>
    </header>

    <section class="stack-3" aria-labelledby="qz-review-title">
      <h2 class="qz-section-title" id="qz-review-title">Question review</h2>
      <div class="qz-review">
        ${(result.questions || []).map((item) => reviewItemHtml(item, questions)).join('')}
      </div>
    </section>

    <div class="qz-actions qz-actions-end">
      <button type="button" class="btn btn-primary" data-new-quiz>${icon('plus', { size: 16 })} New assessment</button>
      <a class="btn btn-secondary" href="study.html?topic=${encodeURIComponent(topic)}">${icon('message', { size: 16 })} Study this topic</a>
      <a class="btn btn-secondary" href="dashboard.html">Back to overview</a>
    </div>
  </article>`;
}

/* ------------------------------------------------------------ after render -- */

function afterRenderQuiz() {
  if (!state.focusQuestion) return;
  state.focusQuestion = false;
  const heading = document.getElementById('qz-question-title');
  if (heading) heading.focus();
}

function afterRenderResults() {
  // Land on the most important sentence. On a 409 replay that is the "already
  // submitted" notice (which has scroll-margin-top from base.css via its id, so
  // the sticky topbar cannot cover it); otherwise the result heading.
  const lead = (state.alreadyAnswered && stage && stage.querySelector('#qz-result-lead'))
    || document.getElementById('qz-result-title');
  if (lead) lead.focus();
}

/* --------------------------------------------------------------- listeners -- */

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!topicInput) return;

  const topic = topicInput.value.trim();
  const problem = topicProblem(topic);
  if (problem) {
    showTopicError(problem);
    topicInput.focus();
    return;
  }
  showTopicError('');

  const params = { topic, questionCount: Number(countSelect ? countSelect.value : 5) };
  const difficulty = form.querySelector('input[name="difficulty"]:checked')?.value || '';
  if (difficulty) params.difficulty = difficulty;
  if (state.session) params.sessionId = state.session.id;

  startQuiz(params);
});

topicInput?.addEventListener('input', () => {
  if (topicInput.getAttribute('aria-invalid') === 'true') showTopicError('');
});

stage?.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.name !== 'qz-choice') return;
  state.answers[state.index] = input.value;
  refreshAnsweredUI();
});

stage?.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('[data-prev]')) { goTo(state.index - 1); return; }
  if (target.closest('[data-next]')) { goTo(state.index + 1); return; }
  if (target.closest('[data-submit]')) { requestSubmit(); return; }
  if (target.closest('[data-submit-anyway]')) { submitQuiz(); return; }
  if (target.closest('[data-answer-unanswered]')) { goToNextUnanswered(); return; }
  if (target.closest('[data-new-quiz]')) { resetToIdle(); return; }
  if (target.closest('[data-retry-generate]')) { startQuiz(state.lastParams); return; }

  const navButton = target.closest('[data-nav-btn]');
  if (navButton) { goTo(Number(navButton.dataset.navBtn)); }
});

/* ------------------------------------------------------------------- init --- */

async function init() {
  await mountShell({ page: 'quiz' });

  // In Supabase mode an unauthorised visitor is redirected by the shell and no
  // shell is mounted; there is nothing for this page to do.
  const host = document.getElementById('app-shell');
  if (!host || !host.classList.contains('app-shell')) return;

  if (presetTopic && topicInput) topicInput.value = presetTopic;

  await loadContext();
  render();
}

init();
