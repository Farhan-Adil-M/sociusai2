// =============================================================================
// pages/study.js — the AI Tutor page.
//
// Responsibility: render ONE grounded chat. The student types a question, the
// page sends it through api.js to POST /api/tutor/ask, and renders the answer
// with markdownLite() plus the server's citations via citationEl().
//
// Deliberately NOT here: file upload (owned by the library page's
// material-import.js), quizzes, flashcards. This page is the conversation only.
//
// Honesty rules this file enforces, from docs/API_CONTRACT.md:
//   · Citations come from the server response ONLY — never built from the
//     model's prose, never invented client-side.
//   · needsContent: true is an honest "I have no material on that", rendered as
//     a distinct state with next steps — never an error and never an empty
//     bubble.
//   · Model text is rendered with ui.js#markdownLite, which escapes first, so
//     the answer can never inject markup.
//   · apiStream() is used so the page keeps working when the server switches
//     from plain JSON to SSE; today it returns plain JSON.
//   · 401 is handled by api.js (refresh + redirect). Everything else maps to a
//     readable message and a retry button using ApiError.code.
// =============================================================================

import { mountShell } from '../components/shell.js';
import { MOCK_BADGE_TEXT, apiGet, apiStream, isMockMode } from '../api.js';
import {
  citationEl, errorMessage, errorState, escapeHtml, icon, markdownLite,
} from '../ui.js';

// Private page: mounts the sidebar/topbar/health pill and moves <main> into the
// content column. In supabase mode an unauthenticated visitor is redirected.
await mountShell({ page: 'study' });

/* --------------------------------------------------------------- elements */

const transcript = document.querySelector('[data-transcript]');
const composer = document.querySelector('[data-composer]');
const input = document.querySelector('#question');
const sendButton = document.querySelector('[data-send]');
const sendLabel = document.querySelector('[data-send-label]');
const countLabel = document.querySelector('[data-count]');
const scopeHost = document.querySelector('[data-scope]');
const demoHost = document.querySelector('[data-demo]');
const live = document.querySelector('[data-live]');

/* ------------------------------------------------------------------ scope
   The tutor may search all of the student's material, one session's material
   (?session=ses_…), or a single source (?source=src_…). The backend enforces
   the scope server-side; this page only reports which scope is active. */

const params = new URLSearchParams(window.location.search);
const sessionParam = (params.get('session') || '').trim();
const sourceParam = (params.get('source') || '').trim();
const topicParam = (params.get('topic') || '').trim();
const presetQuestion = (params.get('q') || (topicParam ? `What should I know about ${topicParam}?` : '')).trim();

let scopedSources = []; // the sources the tutor will search
let scopeTitle = ''; // session title, when ?session= resolves
let sessionEmpty = false; // ?session= resolved to a session with no material
let sending = false;

const STARTERS = [
  'Summarise the key ideas in my material',
  'What should I revise first?',
];

/* ------------------------------------------------------------- small pieces */

function append(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html.trim();
  const node = holder.firstElementChild;
  transcript.appendChild(node);
  scrollToEnd();
  return node;
}

function scrollToEnd() {
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function announce(text) {
  if (live) live.textContent = text;
}

function assistantHead() {
  return `<div class="msg-head">
    <span class="msg-avatar" aria-hidden="true">${icon('spark', { size: 14 })}</span>
    <span class="msg-who">Tutor</span>
  </div>`;
}

/** Server-provided abstain topics (0–4 real topics from the student's own
 *  material). Anything else is ignored — the client never invents a topic. */
function suggestionTopics(data) {
  if (!data || data.needsContent !== true || !Array.isArray(data.suggestions)) return [];
  return data.suggestions
    .filter((topic) => typeof topic === 'string' && topic.trim() !== '')
    .slice(0, 4);
}

function chipsHtml(topics) {
  return topics
    .map((topic) => `<button type="button" class="chip" data-ask="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`)
    .join('');
}

/* ---------------------------------------------------------- message markup */

function userMessageHtml(question) {
  return `<article class="msg msg--user">
    <p class="msg-who sr-only">You asked</p>
    <div class="msg-body">${escapeHtml(question)}</div>
  </article>`;
}

function pendingHtml() {
  return `<div class="msg msg--assistant msg--pending" data-pending>
    ${assistantHead()}
    <div class="msg-body tutor-pending">
      <span class="tutor-typing" data-typing aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="tutor-pending-label" data-pending-label>Searching your material…</span>
      <p class="tutor-stream" data-stream hidden></p>
    </div>
  </div>`;
}

function introHtml() {
  const hasMaterial = scopedSources.length > 0;
  const addAction = hasMaterial
    ? ''
    : `<div class="msg-actions"><a class="btn btn-secondary btn-sm" href="library.html">${icon('plus', { size: 14 })} Add material</a></div>`;
  return `<article class="msg msg--assistant msg--intro">
    ${assistantHead()}
    <div class="msg-body prose">
      <p>Ask me anything about <strong>your material</strong>. I answer only from what you have added,
         and every answer shows the exact file and page it came from.</p>
    </div>
    ${hasMaterial ? `<div class="tutor-starters">${chipsHtml(STARTERS)}</div>` : addAction}
  </article>`;
}

/** A grounded answer, or the honest abstain state when needsContent is true. */
function answerHtml(data, question) {
  const answer = typeof data.answer === 'string' ? data.answer : '';
  const topics = suggestionTopics(data);

  if (data.needsContent === true) {
    return `<article class="msg msg--assistant msg--abstain" data-question="${escapeHtml(question)}">
      <p class="msg-eyebrow">Not covered by your material</p>
      <div class="msg-body prose">${markdownLite(answer)}</div>
      ${topics.length > 0
        ? `<div class="tutor-suggestions">
             <p class="msg-citations-label">Your material does cover these:</p>
             <div class="tutor-starters">${chipsHtml(topics)}</div>
           </div>`
        : ''}
      <div class="msg-actions">
        <a class="btn btn-secondary btn-sm" href="library.html">Add material</a>
      </div>
    </article>`;
  }

  const citations = Array.isArray(data.citations) ? data.citations : [];
  const citationBlock = citations.length === 0
    ? ''
    : `<div class="msg-citations">
    <p class="msg-citations-label">Source passages — select one to read the excerpt</p>
    <div class="citations">${citations.map(citationEl).join('')}</div>
  </div>`;
  const noCitations = citations.length === 0
    ? '<p class="msg-note">No passages were retrieved for this answer.</p>'
    : '';

  return `<article class="msg msg--assistant" data-question="${escapeHtml(question)}">
    ${assistantHead()}
    <div class="msg-body prose">${markdownLite(answer)}</div>
    ${citationBlock}
    ${noCitations}
    ${data.approachUsed ? `<p class="msg-note">Teaching approach: ${escapeHtml(data.approachUsed)}</p>` : ''}
  </article>`;
}

function sessionEmptyHtml() {
  return `<article class="msg msg--assistant msg--abstain">
    <p class="msg-eyebrow">No material in this session yet</p>
    <div class="msg-body prose">
      <p>The tutor searches only this session's material, and there is none yet.
         Add a file or web page first, then ask again.</p>
    </div>
    <div class="msg-actions">
      <a class="btn btn-secondary btn-sm" href="library.html">${icon('plus', { size: 14 })} Add material</a>
    </div>
  </article>`;
}

// Short, human headings for the API's stable codes. Everything else falls back
// to one generic line; the message itself always comes from errorMessage().
const ERROR_TITLES = {
  RATE_LIMITED: 'You are asking a little too fast',
  NIM_ERROR: 'The AI service failed',
  NIM_TIMEOUT: 'The AI service took too long',
  CHROMA_UNAVAILABLE: 'The search index is unavailable',
  NETWORK_ERROR: 'Cannot reach the server',
  SOURCE_NOT_FOUND: 'That material is gone',
  VALIDATION_ERROR: 'That question could not be sent',
};

function errorHtml(error, question) {
  const title = ERROR_TITLES[error && error.code] || 'The tutor could not answer';
  return `<div class="msg msg--assistant msg--error" data-error data-question="${escapeHtml(question)}">
    <div class="alert alert-danger">
      ${icon('alert', { size: 16 })}
      <div class="msg-error-copy">
        <p><strong>${escapeHtml(title)}</strong></p>
        <p>${escapeHtml(errorMessage(error))}</p>
      </div>
    </div>
    <div class="msg-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-retry>
        ${icon('refresh', { size: 14 })} Try again
      </button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------- scope render */

function renderScope() {
  if (!scopeHost) return;
  const count = scopedSources.length;
  const items = `${count} ${count === 1 ? 'item' : 'items'}`;

  if (sessionEmpty) {
    scopeHost.innerHTML = `${icon('folder', { size: 14 })}
      <span>This session has no material yet — <a href="library.html">add material</a> to search it.</span>`;
    return;
  }
  if (sessionParam) {
    const label = scopeTitle ? `«${escapeHtml(scopeTitle)}»` : 'the selected session';
    scopeHost.innerHTML = `${icon('folder', { size: 14 })}
      <span>Searching <strong>${label}</strong> · ${escapeHtml(items)} ·
      <a href="study.html">search all material</a></span>`;
    return;
  }
  if (sourceParam && count === 1) {
    scopeHost.innerHTML = `${icon('file', { size: 14 })}
      <span>Searching <strong>${escapeHtml(scopedSources[0].title)}</strong> ·
      <a href="study.html">search all material</a></span>`;
    return;
  }
  scopeHost.innerHTML = `${icon('folder', { size: 14 })}
    <span>Searching <strong>all your material</strong> · ${escapeHtml(items)}</span>`;
}

function renderDemoNotice() {
  if (!demoHost || !isMockMode()) return;
  demoHost.hidden = false; // the markup ships it hidden; mock mode reveals it
  demoHost.innerHTML = `<p class="alert alert-warn" role="status">
    ${icon('info', { size: 16 })}
    <span><strong>${escapeHtml(MOCK_BADGE_TEXT)}.</strong>
      This page is showing recorded fixtures, not live AI output.</span>
  </p>`;
}

async function loadScope() {
  if (sessionParam) {
    const [sourcesResult, sessionsResult] = await Promise.allSettled([
      apiGet(`/api/sources?sessionId=${encodeURIComponent(sessionParam)}`),
      apiGet('/api/sessions'),
    ]);
    if (sourcesResult.status === 'rejected') throw sourcesResult.reason;
    scopedSources = sourcesResult.value.sources || [];
    if (sessionsResult.status === 'fulfilled') {
      const found = (sessionsResult.value.sessions || []).find((session) => session.id === sessionParam);
      scopeTitle = found ? found.title : '';
    }
    sessionEmpty = scopedSources.length === 0;
    return;
  }

  const data = await apiGet('/api/sources');
  const all = data.sources || [];
  if (sourceParam) {
    const match = all.find((source) => source.id === sourceParam);
    if (match) {
      scopedSources = [match];
      return;
    }
  }
  scopedSources = all;
}

/* ---------------------------------------------------------------- composer */

function updateComposer() {
  if (!input || !sendButton) return;
  const length = input.value.trim().length;
  if (countLabel) countLabel.textContent = `${input.value.length} / 300`;
  input.disabled = sessionEmpty;
  sendButton.disabled = sessionEmpty || sending || length < 3 || length > 300;
  input.placeholder = sessionEmpty
    ? 'Add material to this session first…'
    : 'Ask a question about your material…';
}

/* -------------------------------------------------------------------- ask */

/** The request body for the active scope. Session scope is enforced by the
 *  server; a single-source scope is sent as sourceIds. */
function askBody(question) {
  if (sessionParam) return { question, sessionId: sessionParam };
  if (sourceParam && scopedSources.length === 1) return { question, sourceIds: [sourceParam] };
  return { question };
}

async function ask(question, { echo = true } = {}) {
  const asked = String(question || '').trim();
  if (sending || sessionEmpty) return;
  if (asked.length < 3 || asked.length > 300) return;

  if (echo) append(userMessageHtml(asked));
  const pending = append(pendingHtml());
  sending = true;
  if (sendLabel) sendLabel.textContent = 'Thinking…';
  if (sendButton) sendButton.setAttribute('aria-busy', 'true');
  updateComposer();
  if (input) input.value = '';
  updateComposer();

  let streamed = '';
  try {
    const data = await apiStream('/api/tutor/ask', askBody(asked), (delta) => {
      streamed += delta;
      const streamEl = pending.querySelector('[data-stream]');
      const dots = pending.querySelector('[data-typing]');
      const label = pending.querySelector('[data-pending-label]');
      if (dots) dots.hidden = true;
      if (label) label.hidden = true;
      if (streamEl) {
        streamEl.hidden = false;
        streamEl.textContent = streamed;
      }
      scrollToEnd();
    });

    const final = data && typeof data === 'object' ? data : { answer: streamed, citations: [], needsContent: false };
    if (final.needsContent !== true && !final.answer && streamed) final.answer = streamed;

    pending.outerHTML = answerHtml(final, asked);
    announce(final.needsContent === true ? 'The tutor has no material on that.' : 'The tutor answered.');
  } catch (error) {
    if (error && error.code === 'SESSION_EMPTY') {
      sessionEmpty = true;
      renderScope();
      pending.outerHTML = sessionEmptyHtml();
      announce('This session has no material yet.');
    } else {
      pending.outerHTML = errorHtml(error, asked);
      announce('The tutor could not answer.');
    }
  } finally {
    sending = false;
    if (sendLabel) sendLabel.textContent = 'Send';
    if (sendButton) sendButton.removeAttribute('aria-busy');
    updateComposer();
    scrollToEnd();
  }
}

/* ----------------------------------------------------------------- wiring */

composer?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!input || sending) return;
  const question = input.value.trim();
  if (question.length < 3 || question.length > 300) return;
  ask(question);
});

input?.addEventListener('input', updateComposer);
input?.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter adds a line. `isComposing` lets IME input finish.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer?.requestSubmit();
  }
});

transcript?.addEventListener('click', (event) => {
  const askChip = event.target.closest('[data-ask]');
  if (askChip) {
    const text = askChip.getAttribute('data-ask') || '';
    if (input) input.value = text;
    updateComposer();
    ask(text);
    return;
  }

  const retry = event.target.closest('[data-retry]');
  if (retry) {
    const node = retry.closest('[data-error]');
    const question = node ? node.getAttribute('data-question') || '' : '';
    node?.remove();
    // echo:false — the question bubble from the failed attempt is still on
    // screen, so retry fills in the answer under it instead of duplicating it.
    if (question) ask(question, { echo: false });
  }
});

/* ------------------------------------------------------------------- init */

async function init() {
  renderDemoNotice();
  if (presetQuestion && presetQuestion.length <= 300 && input) input.value = presetQuestion;

  try {
    await loadScope();
  } catch (error) {
    if (transcript) {
      // errorState() returns a DOM node with its retry button already wired.
      transcript.replaceChildren(errorState(error, init, { title: 'Could not load your material' }));
    }
    return;
  }

  renderScope();
  if (transcript) transcript.innerHTML = sessionEmpty ? sessionEmptyHtml() : introHtml();
  updateComposer();
}

init();
