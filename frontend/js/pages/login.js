// =============================================================================
// pages/login.js — the sign-in page.
//
// Two modes, decided by the SERVER, never by this page: `GET /api/health`
// publishes `checks.auth.mode` and auth.js caches it. No URL, key or model id is
// ever bundled here.
//
//   supabase   real account sign-in through the vendored supabase-js client
//              (frontend/vendor/supabase.js — no CDN). Email + password.
//   prototype  no sign-in service connected (or the server is unreachable):
//              a name-only local session. It is clearly labelled as not a real
//              account everywhere it appears, so it can never be mistaken for
//              one.
//
// This page shows the mode, shows the reason auth.js sent the visitor here
// (takeAuthNotice — expired session, forced sign-out), validates before it calls
// anything, and then sends the visitor into the app.
//
// It assumes the other side validates too. The client checks are a courtesy;
// Supabase and the API are the authority.
// =============================================================================

import {
  authReady,
  currentUser,
  getAuthMode,
  getSupabaseClient,
  signInWithName,
  takeAuthNotice,
} from '../auth.js';
import { icon, spinner } from '../ui.js';

/** Where a signed-in visitor lands when nothing else was asked for. */
const DEFAULT_APP_PATH = 'dashboard.html';

/* --------------------------------------------------------------- elements */

const el = (id) => document.getElementById(id);

const form = el('loginForm');
const nameField = el('nameField');
const emailField = el('emailField');
const passwordField = el('passwordField');
const nameInput = el('signinName');
const emailInput = el('signinEmail');
const passwordInput = el('signinPassword');
const nameError = el('nameError');
const emailError = el('emailError');
const passwordError = el('passwordError');
const submitBtn = el('submitBtn');
const togglePassword = el('togglePassword');
const authSub = el('authSub');
const authFoot = el('authFoot');
const authStatus = el('authStatus');
const protoBanner = el('protoBanner');
const realBanner = el('realBanner');
const noticeBanner = el('noticeBanner');
const noticeText = el('noticeText');
const infoBanner = el('infoBanner');
const infoText = el('infoText');
const formError = el('formError');
const formErrorText = el('formErrorText');
const signupFoot = el('signupFoot');
const signupPrompt = el('signupPrompt');
const signupToggle = el('signupToggle');

// Our own messages, our own placement. `novalidate` is already on the form; this
// keeps it true even if the markup is ever edited.
if (form) form.noValidate = true;

// Find out which mode we are in before showing a form. auth.js reads
// GET /api/health for that, which can take a few seconds on a slow connection,
// so say what is happening meanwhile. (The label is static text from this file.)
if (authStatus) {
  authStatus.innerHTML = spinner('Checking how this copy of Socius AI signs people in…');
  authStatus.hidden = false;
}

let authMode = 'prototype'; // 'prototype' until authReady() says otherwise
let signupMode = false; // false = sign in, true = create an account
let busy = false;
let ready = false; // false until the mode is known: the form stays shut until then

/* ---------------------------------------------------------------- notices */

const show = (node, visible) => {
  if (node) node.hidden = !visible;
};

/** One field's own error line, driven by aria-invalid (components.css). */
function setFieldError(input, errorNode, message) {
  if (!input || !errorNode) return;
  errorNode.textContent = message || '';
  errorNode.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function clearFieldErrors() {
  setFieldError(nameInput, nameError, '');
  setFieldError(emailInput, emailError, '');
  setFieldError(passwordInput, passwordError, '');
}

/** A failure the visitor must act on: expired session, wrong password, no server. */
function showProblem(message) {
  if (formErrorText) formErrorText.textContent = message || '';
  show(formError, Boolean(message));
  show(infoBanner, false);
}

/** A success or a heads-up. Not an alarm. */
function showInfo(message) {
  if (infoText) infoText.textContent = message || '';
  show(infoBanner, Boolean(message));
  show(formError, false);
}

/** Both banners clear together: showing one hides the other. */
function clearMessages() {
  showProblem('');
  showInfo('');
}

/* ------------------------------------------------------------- validation */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function problemWithName() {
  const value = (nameInput?.value || '').trim();
  if (!value) return 'Enter your name to continue.';
  if (value.length > 60) return 'Use 60 characters or fewer for your name.';
  return '';
}

function problemWithEmail() {
  const value = (emailInput?.value || '').trim();
  if (!value) return 'Enter your email address.';
  if (!EMAIL_PATTERN.test(value)) return 'That does not look like an email address — try name@example.com.';
  return '';
}

function problemWithPassword() {
  const value = passwordInput?.value || '';
  if (!value) return 'Enter your password.';
  if (value.length < 6) return 'Passwords are at least 6 characters.';
  return '';
}

// Re-check a field on blur, and while typing once it has already failed, so the
// message clears as soon as the input is valid.
[[nameInput, nameError, problemWithName],
 [emailInput, emailError, problemWithEmail],
 [passwordInput, passwordError, problemWithPassword]].forEach(([input, errorNode, check]) => {
  if (!input) return;
  input.addEventListener('blur', () => setFieldError(input, errorNode, check()));
  input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') === 'true') setFieldError(input, errorNode, check());
  });
});

/* ----------------------------------------------------------- password view */

if (togglePassword && passwordInput) {
  const paint = () => {
    const hidden = passwordInput.type === 'password';
    togglePassword.innerHTML = icon(hidden ? 'eye' : 'eyeOff', { size: 17 });
    togglePassword.setAttribute('aria-pressed', String(!hidden));
    togglePassword.setAttribute('aria-label', hidden ? 'Show password' : 'Hide password');
  };
  paint();
  togglePassword.addEventListener('click', () => {
    passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
    paint();
    passwordInput.focus();
  });
}

/* ------------------------------------------------------ mode-dependent UI */

function paintSubmit() {
  if (!submitBtn) return;
  // Disabled until the mode is known: the markup ships it disabled too, so a
  // JavaScript-off page can never submit, and a fast click before the boot
  // settles cannot post against a half-resolved mode.
  submitBtn.disabled = busy || !ready;
  if (busy) submitBtn.textContent = signupMode ? 'Creating account…' : 'Signing in…';
  else if (authMode === 'supabase') submitBtn.textContent = signupMode ? 'Create account' : 'Sign in';
  else submitBtn.textContent = 'Continue';
}

function renderSwitch() {
  if (!signupFoot) return;
  signupFoot.hidden = authMode !== 'supabase';
  if (authMode !== 'supabase') return;
  if (signupPrompt) signupPrompt.textContent = signupMode ? 'Already have an account?' : 'New to Socius AI?';
  if (signupToggle) signupToggle.textContent = signupMode ? 'Sign in instead' : 'Create an account';
}

/**
 * Show only the fields this mode can actually use:
 *   supabase   email + password (the name field belongs to prototype mode)
 *   prototype  the name only — there is no account to sign in to
 * `required` follows visibility so assistive tech announces the truth.
 */
function renderMode() {
  const supabase = authMode === 'supabase';

  show(nameField, !supabase);
  show(emailField, supabase);
  show(passwordField, supabase);
  if (nameInput) nameInput.required = !supabase;
  if (emailInput) emailInput.required = supabase;
  if (passwordInput) passwordInput.required = supabase;
  if (nameInput) nameInput.disabled = supabase;
  if (emailInput) emailInput.disabled = !supabase;
  if (passwordInput) passwordInput.disabled = !supabase;

  show(protoBanner, !supabase);
  show(realBanner, supabase);

  if (authSub) {
    authSub.textContent = supabase
      ? 'Use the email and password of your Socius AI account.'
      : 'Enter your name to open the app on this device.';
  }
  if (authFoot) {
    authFoot.textContent = supabase
      ? 'Your password is checked by the account service and is never stored by this app.'
      : 'Your name is saved in this browser only, so the app can greet you next time.';
  }

  renderSwitch();
  paintSubmit();
}

/* --------------------------------------------------------------- the next */

/**
 * Where to go after signing in. `requireSignIn()` (auth.js) redirects here with
 * `?next=/study.html`, so an interrupted visit resumes where it stopped.
 *
 * Only a site-relative path is accepted. Anything with a scheme, a
 * protocol-relative `//`, a backslash (some browsers read it as `/`) or a
 * character outside the path set falls back to the dashboard, so this parameter
 * can never be used to send someone to another site.
 */
function nextTarget() {
  let raw = '';
  try {
    raw = new URL(window.location.href).searchParams.get('next') || '';
  } catch {
    raw = '';
  }
  const safe = raw.startsWith('/') && !raw.startsWith('//') && /^\/[A-Za-z0-9._~/-]*$/.test(raw);
  return safe ? raw : DEFAULT_APP_PATH;
}

function goTo(path) {
  window.location.assign(path);
}

/* ------------------------------------------------------- supabase failures */

/** Turn an auth-service error into a sentence a student can act on. */
function describeAuthError(error) {
  const raw = String((error && (error.message || error.description || error.code)) || '').toLowerCase();
  if (!raw || raw.includes('failed to fetch') || raw.includes('network')) {
    return 'Could not reach the sign-in service. Check your connection and try again.';
  }
  if (raw.includes('invalid login credentials')) return 'That email and password combination is not right. Check them and try again.';
  if (raw.includes('email not confirmed') || raw.includes('not confirmed')) {
    return 'This email is not confirmed yet. Open the link we emailed you, then sign in.';
  }
  if (raw.includes('rate limit') || raw.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  if (raw.includes('already registered') || raw.includes('already exists')) {
    return 'An account with this email already exists. Sign in with its password instead.';
  }
  if (raw.includes('password should be')) return 'That password is too short for the account service. Use at least 6 characters.';
  return (error && error.message) || 'Sign-in failed. Please try again.';
}

async function submitWithSupabase(email, password) {
  const client = getSupabaseClient();
  if (!client) {
    showProblem('The sign-in client did not load. Reload the page and try again.');
    return;
  }

  try {
    if (signupMode) {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      if (data?.session) {
        goTo(nextTarget()); // email confirmation is off: signed in already
        return;
      }
      showInfo('Account created. Open the confirmation link we emailed you, then sign in here.');
      setSignupMode(false);
      return;
    }

    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data?.session) {
      goTo(nextTarget());
      return;
    }
    showProblem('That did not sign you in. Check your email and password, then try again.');
  } catch (error) {
    showProblem(describeAuthError(error));
  }
}

async function submitWithName(name) {
  try {
    await signInWithName(name);
  } catch (error) {
    showProblem(error?.message || 'Enter your name to continue.');
    return;
  }
  goTo(nextTarget());
}

/* ----------------------------------------------------------------- dispatch */

function setSignupMode(isSignup) {
  signupMode = isSignup;
  if (passwordInput) {
    passwordInput.setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  }
  clearMessages();
  clearFieldErrors();
  renderSwitch();
  paintSubmit();
}

if (signupToggle) {
  signupToggle.addEventListener('click', () => {
    if (authMode !== 'supabase') return; // the switch only exists for real accounts
    setSignupMode(!signupMode);
    emailInput?.focus();
  });
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !ready) return;
    clearMessages();

    if (authMode === 'supabase') {
      const emailProblem = problemWithEmail();
      const passwordProblem = problemWithPassword();
      // Both fields are checked before anything is sent, and both messages are
      // shown at once, so a wrong pair is fixed in one pass. Focus still lands
      // on the first field that needs attention.
      setFieldError(emailInput, emailError, emailProblem);
      setFieldError(passwordInput, passwordError, passwordProblem);
      if (emailProblem) {
        emailInput?.focus();
        return;
      }
      if (passwordProblem) {
        passwordInput?.focus();
        return;
      }

      busy = true;
      paintSubmit();
      try {
        await submitWithSupabase(emailInput.value.trim(), passwordInput.value);
      } finally {
        busy = false;
        paintSubmit();
      }
      return;
    }

    // Prototype: the display name is the whole "account".
    const nameProblem = problemWithName();
    if (nameProblem) {
      setFieldError(nameInput, nameError, nameProblem);
      nameInput?.focus();
      return;
    }

    busy = true;
    paintSubmit();
    try {
      await submitWithName(nameInput.value.trim());
    } finally {
      busy = false;
      paintSubmit();
    }
  });
}

/* -------------------------------------------------------------------- boot */

async function bootLoginPage() {
  // Nothing is rendered before the mode is known: the form and both mode
  // banners stay hidden, so the page never flashes "prototype" at someone who
  // has a real account (or the reverse).
  await authReady();
  authMode = getAuthMode();
  renderMode();
  show(form, true);
  if (authStatus) {
    authStatus.hidden = true;
    authStatus.textContent = '';
  }

  // The reason auth.js sent them here (a session ended, they signed out).
  const notice = takeAuthNotice();

  if (authMode === 'supabase' && getSupabaseClient()) {
    // A restored session means there is nothing to sign in to.
    if (currentUser()) {
      goTo(nextTarget());
      return;
    }
  } else if (authMode !== 'supabase') {
    // Prototype: greet an existing local name instead of making them retype it.
    const existing = currentUser();
    if (existing?.name && nameInput) nameInput.value = existing.name;
  }

  if (notice && noticeText) {
    noticeText.textContent = notice;
    show(noticeBanner, true);
  }

  // Last step: the mode is known, so the form becomes usable and focus lands on
  // the first field this mode actually shows.
  ready = true;
  paintSubmit();
  (authMode === 'supabase' ? emailInput : nameInput)?.focus({ preventScroll: true });
}

bootLoginPage().catch((error) => {
  // Never leave a dead page: the person still deserves to know what happened.
  console.error('[login] failed to start:', error?.message ?? error);
  showProblem('The sign-in page could not start. Reload the page and try again.');
});
