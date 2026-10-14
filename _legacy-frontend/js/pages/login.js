// Login page behaviour. Two modes, decided by the server (js/auth.js reads the
// auth config from /api/health — no keys live in this page's bundle):
//
// - Supabase mode: real email + password sign-in and sign-up through the shared
//   supabase-js client (lazy-loaded from frontend/vendor/supabase.js). Common
//   auth failures get friendly copy; on success we route to dashboard.html,
//   exactly like the prototype did.
// - Prototype mode (dev without Supabase, or the server being unreachable):
//   the historic visual-only flow — nothing is verified or sent anywhere; the
//   display name is stored locally so the dashboard can greet the visitor.
//
// This file is wired to BOTH markup generations, because the redesign lands
// page-by-page. New (redesign) ids are preferred, old hooks are the fallback:
//
//   redesign : #loginForm #studentName #studentEmail #studentPassword #loginFormError
//   legacy   : .auth-form #email #password #<id>-error nodes + banner slots
//
// Every lookup is optional; a missing element is skipped, never a crash.

import { icon } from '../ui.js';
import { authReady, getSupabaseClient, takeAuthNotice } from '../auth.js';

/* --------------------------------------------------------------- elements */

const qs = (selector) => document.querySelector(selector);

const form = qs('#loginForm') || qs('.auth-form');
const nameInput = qs('#studentName');                       // redesign, prototype only
const emailInput = qs('#studentEmail') || qs('#email');
const passwordInput = qs('#studentPassword') || qs('#password');
const formError = qs('#loginFormError');                    // redesign's error slot
const toggle = qs('[data-toggle-password]');                // legacy show/hide button
const prototypeBanner = qs('[data-proto-banner]');
const prototypeFoot = qs('[data-proto-foot]');
const signupFoot = qs('[data-signup-foot]');
const noticeBanner = qs('[data-auth-notice]');
const noticeText = qs('[data-notice-text]');
const infoBanner = qs('[data-auth-info]');
const infoText = qs('[data-info-text]');
const authSub = qs('[data-auth-sub]');
const loginNote = qs('.login-note');                        // redesign's form footnote
const registerBtn = qs('[data-register]');

const submitBtn = form
  ? form.querySelector('[data-submit]')
    || form.querySelector('button[type="submit"]')
    || form.querySelector('.login-submit')
  : null;

// We run our own validation (the redesign markup carries a Gmail-only pattern
// that must not apply to real Socius accounts).
if (form) form.noValidate = true;

let authMode = 'prototype'; // resolved by authReady() below
let signupMode = false;     // false = sign in, true = create account
let busy = false;

/* --------------------------------------------------------------- notices */

/** Inline form error (#loginFormError) — falls back to the legacy banners. */
function showFormError(message) {
  if (formError) {
    formError.textContent = message;
    formError.hidden = !message;
  }
}

function clearFormError() {
  if (formError) {
    formError.textContent = '';
    formError.hidden = true;
  }
}

function showNotice(kind, message) {
  // The form's error slot wins: it is the redesign's contract element
  // (#loginFormError). The legacy banner slots are the fallback for pages
  // that predate it.
  if (formError) {
    showFormError(message);
    if (noticeBanner) noticeBanner.hidden = true;
    if (infoBanner) infoBanner.hidden = true;
    return;
  }
  const isInfo = kind === 'info';
  if (noticeBanner && noticeText && infoBanner && infoText) {
    noticeBanner.hidden = isInfo;
    infoBanner.hidden = !isInfo;
    (isInfo ? infoText : noticeText).textContent = message;
  }
}

function hideNotices() {
  if (noticeBanner) noticeBanner.hidden = true;
  if (infoBanner) infoBanner.hidden = true;
  if (noticeText) noticeText.textContent = '';
  if (infoText) infoText.textContent = '';
  clearFormError();
}

/** Message left for us by api.js after an UNAUTHENTICATED 401 (redirection). */
function showExpiryNotice(message) {
  if (message) showNotice('error', message);
}

/* ------------------------------------------------------- field visibility */

/**
 * Show/hide one input together with its label and (when present) its
 * `.field` wrapper, using inline display so nothing depends on `[hidden]`
 * surviving the stylesheet.
 */
function setFieldVisible(input, visible) {
  if (!input) return;
  const wrapper = input.closest('.field') || input.closest('.login-field') || input.closest('.form-group');
  const targets = wrapper ? [wrapper] : [input];
  const label = input.id ? form?.querySelector(`label[for="${input.id}"]`) : null;
  if (label && !wrapper) targets.push(label);
  targets.forEach((node) => {
    node.hidden = !visible;
    node.style.display = visible ? '' : 'none';
  });
  input.disabled = !visible;
  input.required = visible && isRequiredField(input);
}

function isRequiredField(input) {
  if (input === passwordInput) return authMode === 'supabase';
  if (input === nameInput) return authMode !== 'supabase' && Boolean(nameInput);
  if (input === emailInput) return authMode === 'supabase' || !nameInput;
  return false;
}

/**
 * Which fields the current mode shows:
 *  - supabase  → email + password (the name field is prototype-only)
 *  - prototype → name only when #studentName exists; otherwise the legacy
 *                email-greeting flow (password hidden either way)
 */
function applyFieldVisibility() {
  const supabase = authMode === 'supabase';
  setFieldVisible(nameInput, !supabase && Boolean(nameInput));
  setFieldVisible(emailInput, supabase || !nameInput);
  setFieldVisible(passwordInput, supabase);
}

/* ------------------------------------------------------ mode-dependent UI */

function submitLabel() {
  if (busy) return signupMode && authMode === 'supabase' ? 'Creating account…' : 'Signing in…';
  if (authMode !== 'supabase') return nameInput ? 'Continue' : 'Sign in to the demo';
  return signupMode ? 'Create account' : 'Sign in';
}

function setBusy(next) {
  busy = next;
  if (submitBtn) {
    submitBtn.disabled = next;
    submitBtn.textContent = submitLabel();
  }
}

function renderSignupFoot() {
  if (!signupFoot) return;
  signupFoot.innerHTML = signupMode
    ? 'Already have an account? <a href="#" data-signup-toggle>Sign in instead</a>.'
    : 'New to Socius AI? <a href="#" data-signup-toggle>Create an account</a>.';
  signupFoot.querySelector('[data-signup-toggle]')?.addEventListener('click', (event) => {
    event.preventDefault();
    setSignupMode(!signupMode);
  });
}

function setSignupMode(isSignup) {
  signupMode = isSignup;
  if (passwordInput) {
    passwordInput.setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  }
  renderSignupFoot();
  hideNotices();
  if (submitBtn) submitBtn.textContent = submitLabel();
}

/**
 * Switch the page to the real (Supabase) flow: hide the prototype caveats,
 * relabel the buttons and expose the create-account link.
 */
function useSupabaseMode() {
  authMode = 'supabase';
  if (registerBtn) registerBtn.hidden = false; // real accounts only
  if (prototypeBanner) prototypeBanner.hidden = true;
  if (prototypeFoot) prototypeFoot.hidden = true;
  if (authSub) authSub.textContent = 'Sign in with your Socius AI account email and password.';
  if (loginNote) loginNote.textContent = 'Use the email and password of your Socius AI account.';
  if (signupFoot) { signupFoot.hidden = false; }
  applyFieldVisibility();
  setSignupMode(false);
  if (submitBtn) submitBtn.textContent = submitLabel();
}

/* ------------------------------------------------------------- validation */

/** Per-field message, shown inline when the markup has a `<id>-error` node. */
function setError(input, message) {
  if (!input || !input.id) return;
  const error = document.getElementById(`${input.id}-error`);
  if (!error) return;
  if (message) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  } else {
    error.textContent = '';
    error.hidden = true;
    input.removeAttribute('aria-invalid');
  }
}

function validateEmail() {
  const value = (emailInput?.value || '').trim();
  if (!value) return 'Enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'That does not look like an email address — try name@example.com.';
  }
  return '';
}

function validatePassword() {
  const value = passwordInput?.value || '';
  if (!value) return 'Enter a password.';
  if (value.length < 6) return 'Use at least 6 characters.';
  return '';
}

function validateName() {
  const value = (nameInput?.value || '').trim();
  if (!value) return 'Enter your name.';
  if (value.length > 60) return 'Use 60 characters or fewer for your name.';
  return '';
}

if (emailInput) {
  emailInput.addEventListener('blur', () => setError(emailInput, validateEmail()));
  emailInput.addEventListener('input', () => {
    if (emailInput.getAttribute('aria-invalid')) setError(emailInput, validateEmail());
  });
}
if (passwordInput) {
  passwordInput.addEventListener('blur', () => setError(passwordInput, validatePassword()));
  passwordInput.addEventListener('input', () => {
    if (passwordInput.getAttribute('aria-invalid')) setError(passwordInput, validatePassword());
  });
}
if (nameInput) {
  nameInput.addEventListener('blur', () => setError(nameInput, validateName()));
}

if (toggle && passwordInput) {
  toggle.innerHTML = icon('eye', { size: 17 });
  toggle.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    toggle.setAttribute('aria-pressed', String(!showing));
    toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    toggle.innerHTML = icon(showing ? 'eye' : 'eyeOff', { size: 17 });
    passwordInput.focus();
  });
}

/* ------------------------------------------------------------ the real flow */

/** Supabase error text → something a student can act on. */
function describeAuthError(error) {
  const raw = String((error && (error.message || error.description || error.code)) || '').toLowerCase();
  if (!raw || raw.includes('failed to fetch')) {
    return 'Could not reach the sign-in service — check your connection and try again.';
  }
  if (raw.includes('invalid login credentials')) return 'That email and password combination is not correct. Check them and try again.';
  if (raw.includes('not confirmed')) return 'This email has not been confirmed yet — click the link in the email we sent you, then sign in.';
  if (raw.includes('rate limit') || raw.includes('too many')) return 'Too many attempts — wait a minute and try again.';
  if (raw.includes('already registered')) return 'An account with this email already exists — sign in with its password.';
  return (error && error.message) || 'Sign-in failed — please try again.';
}

/** Post-login destination (unchanged behaviour: straight to the dashboard). */
function goToDashboard() {
  window.location.href = 'dashboard.html';
}

async function realSubmit(isSignup, email, password) {
  const client = getSupabaseClient();
  if (!client) {
    showNotice('error', 'The sign-in client failed to load — reload the page and try again.');
    return;
  }
  setBusy(true);
  hideNotices();
  try {
    if (isSignup) {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) {
        // Email confirmation is off — the user is signed in right away.
        goToDashboard();
        return;
      }
      showNotice('info', 'Account created. We sent a confirmation email — open the link in it, then sign in here.');
      setSignupMode(false);
      return;
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data && data.session) goToDashboard();
  } catch (error) {
    showNotice('error', describeAuthError(error));
  } finally {
    setBusy(false);
  }
}

/** Prototype mode: the display name only (never sent anywhere). */
function savePrototypeName(displayName) {
  try { localStorage.setItem('socius_user', displayName); } catch { /* storage blocked: still continue */ }
}

/* --------------------------------------------------------------- dispatch */

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  hideNotices();

  if (authMode === 'supabase') {
    const emailProblem = validateEmail();
    const passwordProblem = validatePassword();
    if (emailProblem) {
      setError(emailInput, emailProblem);
      showFormError(emailProblem);
      emailInput?.focus();
      return;
    }
    if (passwordProblem) {
      setError(passwordInput, passwordProblem);
      showFormError(passwordProblem);
      passwordInput?.focus();
      return;
    }
    setError(emailInput, '');
    setError(passwordInput, '');
    realSubmit(signupMode, emailInput.value.trim(), passwordInput.value);
    return;
  }

  // Prototype flow: name-only on the redesign; the historic email-local-part
  // greeting when the page still has the old markup.
  if (nameInput) {
    const nameProblem = validateName();
    if (nameProblem) { showFormError(nameProblem); nameInput.focus(); return; }
    savePrototypeName(nameInput.value.trim());
  } else {
    const emailProblem = validateEmail();
    if (emailProblem) {
      setError(emailInput, emailProblem);
      showFormError(emailProblem);
      emailInput?.focus();
      return;
    }
    savePrototypeName(emailInput.value.trim().split('@')[0]);
  }
  goToDashboard();
});

/* -------------------------------------------------------------------- boot */

// Create-account switch (supabase mode): only when the markup has the link.
registerBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  if (authMode !== 'supabase') return; // only exists for real accounts
  setSignupMode(true);
  emailInput?.focus();
});

(async function bootLoginPage() {
  applyFieldVisibility(); // sensible defaults before the mode resolves

  const outcome = await authReady();

  if (outcome.mode === 'supabase' && getSupabaseClient()) {
    useSupabaseMode();
    // Already signed in (client-side restore) → straight to the dashboard.
    const { data } = await getSupabaseClient().auth.getSession();
    if (data && data.session) {
      goToDashboard();
      return;
    }
  } else {
    applyFieldVisibility(); // prototype: name only, password hidden
    if (submitBtn) submitBtn.textContent = submitLabel();
  }

  // A message left by api.js after an UNAUTHENTICATED 401 ("session expired").
  showExpiryNotice(takeAuthNotice());

  setBusy(false);
})();
