// Quiz page: generate → answer one question at a time → submit the whole
// attempt → results with the answer key, explanations and mastery update.
//
// The answer key never appears in this file before POST /api/quiz/:id/answer
// returns it: the generate response has no correctChoiceId, and nothing here
// guesses which option is right.

import { mountShell, mountHealthBanner } from '../components/shell.js';
import { populateScopeSelect } from '../components/scope-select.js';
import { api } from '../api.js';
import {
  icon, escapeHtml, renderCitations, wireCitations, errorMessage,
  setTopicError, topicCheck, setGenerating,
} from '../ui.js';

const GENERATING_LABELS = { ready: 'Start quiz', busy: 'Writing questions…' };

mountShell('quiz');
mountHealthBanner(document.querySelector('[data-health]'));

/* Hosts: the redesign's assessments view renders the active question inside
   #quizQuestionBox (demo4.1 lines 753–773). The classic page keeps its own
   [data-stage]; when that is missing we render into the demo box (or the
   whole assessments view), and finally into a detached element so a missing
   host never crashes the page. */
const stage = document.querySelector('[data-stage]')
  || document.getElementById('quizQuestionBox')
  || document.getElementById('viewAssessments')
  || document.createElement('div');
const live = document.querySelector('[data-live]') || document.createElement('p');
const setupStatus = document.querySelector('[data-setup-status]') || document.createElement('div');
const form = document.querySelector('[data-generate-form]');
const topicInput = document.querySelector('#qz-topic');
const topicError = document.querySelector('#qz-topic-error');
const countSelect = document.querySelector('#qz-count');
const scopeSelect = document.querySelector('#qz-scope');
const generateButton = document.querySelector('[data-generate]');

const stageIcon = document.querySelector('[data-stage-icon]');
if (stageIcon) stageIcon.innerHTML = icon('clipboard', { size: 20 });

wireCitations(stage);

/* Session scope: ?session=ses_… makes the whole quiz search that session's
   material only — the backend enforces it, this just tells the student. */
const search = new URLSearchParams(window.location.search);
const presetTopic = (search.get('topic') || '').trim();
const presetSessionId = (search.get('session') || '').trim();
let sessionContext = null;

async function loadSessionContext() {
  if (!presetSessionId) return;
  try {
    const data = await api.getSession(presetSessionId);
    sessionContext = data.session;
    const chip = document.querySelector('[data-session-chip]');
    if (chip) {
      chip.textContent = `Scope: ${data.session.title}`;
      chip.href = `session.html?id=${encodeURIComponent(data.session.id)}`;
      chip.title = 'This quiz only searches material in this session. Open the session.';
      chip.hidden = false;
    }
  } catch {
    sessionContext = null; // fall back to all material; errors surface on generate
  }
}

loadSessionContext().then(() => {
  if (scopeSelect) {
    populateScopeSelect(scopeSelect, document.querySelector('[data-scope-note]'),
      { sessionId: sessionContext ? sessionContext.id : null });
  }
});

const state = {
  quiz: null,     // { id, topic, difficulty, questions }
  index: 0,
  answers: [],    // choiceId | null, one per question
  locked: [],     // has this question been submitted locally?
  warning: false, // showing the "unanswered questions" warning
  result: null,   // filled only after POST /answer succeeds
  submitting: false,
  error: null,    // submit error banner
};

/* ------------------------------------------------------------ generation */

function setSetupStatus(kind, message) {
  setupStatus.innerHTML = message ? `<div class="banner banner-${kind}">${escapeHtml(message)}</div>` : '';
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!topicInput) return;
  const topic = topicInput.value.trim();

  const problem = topicCheck(topicInput);
  if (problem) {
    if (topicError) setTopicError(topicInput, topicError, problem);
    topicInput.focus();
    return;
  }
  if (topicError) setTopicError(topicInput, topicError, '');
  setSetupStatus('', '');

  const difficulty = form.querySelector('input[name="difficulty"]:checked')?.value || '';
  const sourceIds = scopeSelect && scopeSelect.value ? [scopeSelect.value] : [];

  if (generateButton) setGenerating(generateButton, GENERATING_LABELS, true);
  try {
    const data = await api.generateQuiz({
      topic,
      questionCount: Number(countSelect.value),
      difficulty,
      sourceIds,
      sessionId: sessionContext ? sessionContext.id : null,
    });
    const questions = data.quiz.questions;
    state.quiz = data.quiz;
    state.index = 0;
    state.answers = questions.map(() => null);
    state.locked = questions.map(() => false);
    state.result = null;
    state.warning = false;
    state.error = null;
    render();
    live.textContent = `Quiz ready: ${questions.length} questions.`;
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (error.code === 'SESSION_EMPTY') {
      setSetupStatus('warn', `${icon('info', { size: 16 })} <span><strong>${escapeHtml(sessionContext ? sessionContext.title : 'This session')} has no material yet.</strong>
        Add a file or web page first — then quizzes can search it.
        <a href="session.html?id=${encodeURIComponent(presetSessionId)}">Add material</a></span>`);
    } else {
      setSetupStatus('error', errorMessage(error));
    }
  } finally {
    if (generateButton) setGenerating(generateButton, GENERATING_LABELS, false);
  }
});

/* --------------------------------------------------------------- helpers */

function choiceText(question, choiceId) {
  if (choiceId == null) return null;
  const choice = (question.choices || []).find((item) => item.id === choiceId);
  return choice ? choice.text : null;
}

function placeholder() {
  stage.innerHTML = `
    <div class="panel"><div class="panel-body">
      <div class="state">
        <span class="state-icon">${icon('clipboard', { size: 20 })}</span>
        <span class="state-title">No quiz yet</span>
        <p class="state-text">Choose a topic below. Socius AI writes the questions, and your score decides the difficulty of the next set.</p>
      </div>
    </div></div>`;
  syncAssessmentChrome();
}

/* ---------------------------------------------------- assessments chrome ---
   The redesign's assessments view has chrome elements that may live OUTSIDE
   whatever stage we render into: #quizQCounter, #quizSubjectBadge and
   #quizSessionScore. Elements inside the stage are replaced by our own
   markup, so these lookups simply miss and do nothing. Accuracy stays '—'
   until the quiz is submitted: the answer key must not reach this page
   before then. */
function syncAssessmentChrome() {
  const counter = document.getElementById('quizQCounter');
  if (counter && state.quiz) {
    counter.textContent = `Question ${state.index + 1} of ${state.quiz.questions.length}`;
  }
  const badge = document.getElementById('quizSubjectBadge');
  if (badge && state.quiz) badge.textContent = state.quiz.topic;
  const scorePill = document.getElementById('quizSessionScore');
  if (scorePill && state.quiz) {
    scorePill.textContent = state.result ? `${state.result.score.percent}%` : '—';
  }
}

/* Redesign extra: the assessments view ships a close button that means "back
   to overview" in the demo. On a standalone page there is no modal to close,
   so it returns to the dashboard instead. */
document.getElementById('closeQuizModalBtn')?.addEventListener('click', () => {
  window.location.href = 'dashboard.html';
});

/* -------------------------------------------------------------- question */

function renderQuestion() {
  const questions = state.quiz.questions;
  const total = questions.length;
  const question = questions[state.index];
  const selected = state.answers[state.index];
  const locked = state.locked[state.index];
  const isLast = state.index === total - 1;
  const unanswered = state.answers.filter((answer) => answer === null).length;

  const options = question.choices.map((choice) => {
    const isSelected = selected === choice.id;
    return `
      <label class="qz-option${isSelected ? ' is-selected' : ''}${locked ? ' is-locked' : ''}">
        <input type="radio" name="qz-choice" value="${escapeHtml(choice.id)}"
               ${isSelected ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span class="qz-option-key">${escapeHtml(choice.id)}</span>
        <span class="qz-option-text">${escapeHtml(choice.text)}</span>
        ${isSelected ? `<span class="qz-option-check">${icon('checkCircle', { size: 17 })}</span>` : ''}
      </label>`;
  }).join('');

  const warning = state.warning
    ? `<div class="banner banner-warn qz-warn">${icon('alert', { size: 16 })}
        <span><strong>${unanswered} ${unanswered === 1 ? 'question is' : 'questions are'} unanswered.</strong> Unanswered questions count as wrong. Submit anyway, or go back and answer them.
          <span class="qz-actions-center" style="margin-top: var(--s2);">
            <button type="button" class="btn btn-secondary btn-sm" data-answer-unanswered>Answer the unanswered question${unanswered === 1 ? '' : 's'}…</button>
            <button type="button" class="btn btn-secondary btn-sm" data-dismiss-warning>Submit anyway — unanswered count as wrong</button>
          </span>
        </span>
      </div>`
    : '';

  const submitError = state.error
    ? `<div class="banner banner-error" style="margin-bottom: var(--s3);">${icon('alert', { size: 16 })}
        <span><strong>Could not submit the quiz.</strong> ${escapeHtml(errorMessage(state.error))}</span>
      </div>`
    : '';

  let primaryLabel;
  let primaryAction;
  if (state.submitting) {
    primaryLabel = '<span class="spinner" aria-hidden="true"></span> Submitting…';
    primaryAction = 'submitting';
  } else if (state.warning) {
    primaryLabel = 'Submit anyway';
    primaryAction = 'submit-anyway';
  } else if (!locked) {
    primaryLabel = 'Submit answer';
    primaryAction = 'lock';
  } else if (isLast) {
    primaryLabel = 'Submit quiz';
    primaryAction = 'finish';
  } else {
    primaryLabel = `Continue ${icon('arrowRight', { size: 15 })}`;
    primaryAction = 'continue';
  }

  stage.innerHTML = `
    <div class="session-card">
      <div class="session-card-head">
        <div>
          <p class="qz-topic-name">${escapeHtml(state.quiz.topic)}</p>
          <div class="session-card-meta">
            <span class="badge badge-blue">${escapeHtml(state.quiz.difficulty || 'mixed')}</span>
            <span>Answer key is revealed only after you submit</span>
          </div>
        </div>
        <p class="qz-count">Question ${state.index + 1} of ${total}</p>
      </div>

      <div class="qz-progress">
        <div class="progress" role="img" aria-label="Question ${state.index + 1} of ${total}">
          <div class="progress-bar" style="width: ${Math.round(((state.index + 1) / total) * 100)}%"></div>
        </div>
      </div>

      <div class="qz-body">
        ${submitError}
        ${warning}
        <p class="qz-question-num">Question ${state.index + 1}</p>
        <h2 class="qz-question">${escapeHtml(question.text)}</h2>
        <fieldset class="qz-options" ${locked ? 'disabled' : ''}>
          <legend class="sr-only">Choose one answer</legend>
          ${options}
        </fieldset>
      </div>

      <div class="qz-actions">
        <button type="button" class="btn btn-secondary" data-prev ${state.index === 0 || state.submitting ? 'disabled' : ''}>
          ${icon('chevronLeft', { size: 15 })} Previous
        </button>
        <div class="qz-actions-center">
          ${locked && !state.submitting ? '<button type="button" class="btn btn-quiet" data-change>Change answer</button>' : ''}
          <button type="button" class="btn btn-primary" data-primary="${primaryAction}" ${primaryAction === 'submitting' || (!locked && selected === null) ? 'disabled' : ''}>
            ${primaryLabel}
          </button>
        </div>
        <p class="field-hint" style="text-align: right;">${locked ? 'Answer locked in — you can still change it.' : 'Pick an option, then submit it.'}</p>
      </div>
    </div>`;
  syncAssessmentChrome();
}

/* --------------------------------------------------------------- results */

function renderResults() {
  const result = state.result;
  const score = result.score;
  const mastery = result.masteryUpdate;
  const questions = state.quiz ? state.quiz.questions : [];

  const masteryBlock = mastery ? `
    <div class="qz-mastery">
      <div class="meter-label">
        <strong>${escapeHtml(mastery.topic)} mastery</strong>
        <span>${Math.round(mastery.before * 100)}% → ${Math.round(mastery.after * 100)}%</span>
      </div>
      <div class="progress" role="img" aria-label="Mastery ${Math.round(mastery.after * 100)} percent">
        <div class="progress-bar${mastery.after < 0.6 ? ' is-pink' : ''}" style="width: ${Math.round(mastery.after * 100)}%"></div>
      </div>
      <p class="row-meta" style="margin-top: var(--s2);">
        ${mastery.delta >= 0 ? '+' : ''}${Math.round(mastery.delta * 100)} points this attempt
        ${result.recommendedDifficulty ? ` · next quiz: <strong>${escapeHtml(result.recommendedDifficulty)}</strong>` : ''}
      </p>
    </div>` : '';

  const review = (result.questions || []).map((item) => {
    const question = questions[item.index] || { text: 'Question', choices: [] };
    const yourText = choiceText(question, item.yourChoiceId);
    const correctText = choiceText(question, item.correctChoiceId);
    const correct = item.correct;

    return `
      <article class="qz-review-item ${correct ? 'is-correct' : 'is-wrong'}">
        <div class="qz-review-head">
          <span class="badge ${correct ? 'badge-green' : 'badge-pink'}">
            ${icon(correct ? 'check' : 'close', { size: 12 })} ${correct ? 'Correct' : 'Incorrect'}
          </span>
          <span class="row-meta">Question ${item.index + 1}</span>
        </div>
        <p class="qz-review-question">${escapeHtml(question.text)}</p>

        <div class="qz-answer-line ${correct ? 'is-correct' : 'is-your-wrong'}">
          <span class="badge">${correct ? 'Your answer' : 'You said'}</span>
          <strong>${yourText ? escapeHtml(yourText) : 'No answer given'}</strong>
        </div>
        ${correct ? '' : `
          <div class="qz-answer-line is-correct">
            <span class="badge badge-green">Correct answer</span>
            <strong>${escapeHtml(correctText || 'Unknown')}</strong>
          </div>`}

        ${item.explanation ? `
          <div class="qz-explanation">
            <span class="qz-explanation-label">Why</span>
            ${escapeHtml(item.explanation)}
          </div>` : ''}

        ${Array.isArray(item.citations) && item.citations.length ? `
          <div class="qz-review-citations">
            <p class="exchange-citations-label">Source passages</p>
            ${renderCitations(item.citations, `q${item.index}`)}
          </div>` : ''}
      </article>`;
  }).join('');

  stage.innerHTML = `
    <div class="session-card">
      <div class="qz-result-head">
        <div class="qz-score">
          <span class="qz-score-value">${score.percent}%</span>
          <span class="qz-score-label">${score.correct} of ${score.total} correct</span>
        </div>
        <div class="qz-result-detail">
          <h2>${escapeHtml(state.quiz ? state.quiz.topic : (mastery ? mastery.topic : 'Results'))}</h2>
          <p>${score.percent >= 80
            ? 'Strong result — the next quiz will step up in difficulty.'
            : score.percent >= 50
              ? 'Solid work. The next quiz stays at the same difficulty.'
              : 'This one was rough — the next quiz will ease off so you can rebuild.'}</p>
          ${masteryBlock}
        </div>
      </div>

      <div class="qz-review">${review}</div>

      <div class="qz-result-actions">
        <a class="btn btn-primary" href="study.html?topic=${encodeURIComponent(mastery ? mastery.topic : (state.quiz ? state.quiz.topic : ''))}">Study this topic again</a>
        <button type="button" class="btn btn-secondary" data-new-quiz>New quiz</button>
        <a class="btn btn-secondary" href="dashboard.html">Back to dashboard</a>
      </div>
    </div>`;
  syncAssessmentChrome();
}

/* ---------------------------------------------------------------- render */

function render() {
  if (state.result) { renderResults(); return; }
  if (state.quiz) { renderQuestion(); return; }
  placeholder();
}

/* -------------------------------------------------------------- actions */

function selectChoice(choiceId) {
  state.answers[state.index] = choiceId;
  state.warning = false;
  renderQuestion();
}

function lockAnswer() {
  if (state.answers[state.index] === null) return;
  state.locked[state.index] = true;
  state.warning = false;
  renderQuestion();
  live.textContent = 'Answer submitted. Continue to the next question.';
}

function changeAnswer() {
  state.locked[state.index] = false;
  state.warning = false;
  renderQuestion();
}

function goTo(index) {
  if (index < 0 || index >= state.quiz.questions.length) return;
  state.index = index;
  state.warning = false;
  renderQuestion();
  live.textContent = `Question ${state.index + 1} of ${state.quiz.questions.length}.`;
}

async function submitQuiz() {
  if (state.submitting) return;
  state.warning = false;
  state.error = null;
  state.submitting = true;
  renderQuestion();

  const answers = state.answers.map((choiceId, index) => ({ index, choiceId }));

  try {
    const data = await api.answerQuiz(state.quiz.id, answers);
    state.result = data.result;
    render();
    live.textContent = `Quiz submitted. Score ${data.result.score.percent} percent.`;
    stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    state.submitting = false;
    // Contract: a repeat submission returns the stored result instead of a new grade.
    const stored = error && error.data ? error.data.result : null;
    if (stored) {
      state.result = stored;
      render();
      live.textContent = 'This quiz was already submitted — showing your stored result.';
      return;
    }
    state.error = error;
    renderQuestion();
    live.textContent = `Could not submit: ${errorMessage(error)}`;
  } finally {
    state.submitting = false;
  }
}

/* ------------------------------------------------------------- listeners */

stage.addEventListener('change', (event) => {
  const radio = event.target.closest('input[name="qz-choice"]');
  if (radio) selectChoice(radio.value);
});

stage.addEventListener('click', (event) => {
  const target = event.target;
  const primary = target.closest('[data-primary]');
  const action = primary ? primary.dataset.primary : null;

  if (action === 'lock') { lockAnswer(); return; }
  if (action === 'continue') { goTo(state.index + 1); return; }
  const unansweredIndex = state.answers.findIndex((a) => a === null);
  if (action === 'answer-unanswered' && unansweredIndex >= 0) {
    goTo(unansweredIndex);
    return;
  }
  if (action === 'submit-anyway') { submitQuiz(); return; }
  if (action === 'finish') {
    const unanswered = state.answers.filter((answer) => answer === null).length;
    if (unanswered > 0) { state.warning = true; renderQuestion(); return; }
    submitQuiz();
    return;
  }
  if (action === 'submitting') return;

  if (target.closest('[data-change]')) { changeAnswer(); return; }
  if (target.closest('[data-prev]')) { goTo(state.index - 1); return; }
  if (target.closest('[data-dismiss-warning]')) { state.warning = false; renderQuestion(); return; }

  if (target.closest('[data-new-quiz]')) {
    state.quiz = null;
    state.result = null;
    state.index = 0;
    state.answers = [];
    state.locked = [];
    render();
    topicInput?.focus();
  }
});

/* ------------------------------------------------------------------ init */

if (presetTopic && topicInput) topicInput.value = presetTopic;

render();
