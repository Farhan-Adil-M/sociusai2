// POST /api/auth/login   { email, password } → the Supabase session (tokens + user)
// POST /api/auth/refresh { refresh_token }    → a fresh session
//
// These exist for the browser extension, which has no Supabase client library
// and talks to ONE base URL. The website keeps logging in directly against
// Supabase from the browser (frontend/js/auth.js) — unchanged.
//
// Trust model: these are the only two UNAUTHENTICATED endpoints that touch
// credentials. They sit behind a hand-rolled in-memory rate limiter (per IP
// and per subject) so a single client cannot brute-force accounts, and both
// failure paths return the SAME generic message so the response never reveals
// whether an account exists. Sessions are real Supabase sessions (the same
// ones the website gets), so the backend's Bearer verification
// (middleware/auth.js) accepts them on every private endpoint. Passwords and
// tokens are never logged.

import express from 'express';
import { createHash } from 'node:crypto';
import { ApiError } from '../middleware/errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Supabase refresh tokens are opaque, printable, whitespace-free strings.
// Bound the size and charset so garbage never reaches the provider (or the
// rate-limiter keys) — but keep it loose enough for real token formats.
const REFRESH_TOKEN_RE = /^[!-~]{1,4096}$/;

// --- hand-rolled rate limiting (no dependency) -----------------------------
//
// A small sliding window: each key keeps the timestamps of its recent
// attempts. Two namespaces are checked for every login/refresh — the client
// IP (blunt flood protection) and the subject (email, or a hash of the refresh
// token) so one account cannot be hammered from many IPs either. Reset on a
// successful login so a legitimate user is never locked out by their own typos.

const RATE_WINDOW_MS = positiveInt(process.env.AUTH_RATE_WINDOW_MS, 15 * 60 * 1000);
const RATE_IP_MAX = positiveInt(process.env.AUTH_RATE_MAX_IP, 30);
const RATE_SUBJECT_MAX = positiveInt(process.env.AUTH_RATE_MAX_SUBJECT, 8);

/** Parse an env-tunable positive integer, falling back when absent/invalid. */
function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Sliding-window attempt counter over a Map of key → timestamps. */
function createAttemptLimiter({ windowMs, max }) {
  const hits = new Map();
  let lastSweep = 0;

  // Drop keys whose attempts have all aged out. Runs at most once per window,
  // so the Map cannot grow without bound on a long-lived server.
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, times] of hits) {
      const kept = times.filter((t) => now - t < windowMs);
      if (kept.length > 0) hits.set(key, kept);
      else hits.delete(key);
    }
  }

  return {
    isLimited(key, now) {
      sweep(now);
      const times = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (times.length === 0) hits.delete(key);
      else hits.set(key, times);
      return times.length >= max;
    },
    record(key, now) {
      const times = hits.get(key) ?? [];
      times.push(now);
      hits.set(key, times);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

/** The refresh token is hashed before it is ever used as a Map key or label. */
function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

const RATE_LIMITED = {
  error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' },
};

/** The only session shape that ever leaves this router (no extra Supabase fields). */
function sessionEnvelope(session, user) {
  const who = user ?? session?.user ?? {};
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    expires_in: session.expires_in ?? null,
    token_type: session.token_type ?? 'bearer',
    user: { id: who.id ?? '', email: who.email ?? '' },
  };
}

export function authRouter({ auth }) {
  const router = express.Router();
  const ipLimiter = createAttemptLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_IP_MAX });
  const subjectLimiter = createAttemptLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_SUBJECT_MAX });

  // Prototype mode: no auth exists. Say so instead of pretending to sign in —
  // the extension reads `mode` and hides its login UI.
  const reportPrototype = (req, res) => res.json({ mode: 'prototype' });

  /**
   * Apply both limits to this attempt. Returns true when the caller should
   * stop with a 429 (and has already been answered), false when the attempt
   * was recorded and the handler may continue.
   *
   * The check runs BEFORE input validation so malformed floods are counted
   * too; the subject key is only derived when one is available.
   */
  function rateLimited(req, res, subject) {
    const now = Date.now();
    const ipKey = `ip:${req.ip ?? 'unknown'}`;
    const subjKey = subject ? `subject:${subject}` : null;
    if (ipLimiter.isLimited(ipKey, now) || (subjKey && subjectLimiter.isLimited(subjKey, now))) {
      res.status(429)
        .set('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)))
        .json(RATE_LIMITED);
      return true;
    }
    ipLimiter.record(ipKey, now);
    if (subjKey) subjectLimiter.record(subjKey, now);
    return false;
  }

  // POST /api/auth/login — password grant via Supabase Auth.
  router.post('/login', async (req, res) => {
    if (!auth || auth.mode !== 'supabase') return reportPrototype(req, res);

    const { email, password } = req.body ?? {};
    const subject = typeof email === 'string' && email.trim() !== ''
      ? `login:${email.trim().toLowerCase()}`
      : null;
    if (rateLimited(req, res, subject)) return;

    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())
      || typeof password !== 'string' || password.length < 1) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a valid email and password.');
    }

    const { data, error } = await auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data?.session) {
      // Credentials are wrong (or unconfirmed) — one honest message, no internals.
      return res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Email or password is incorrect.' },
      });
    }

    // A real success clears the subject counter (typos shouldn't accumulate),
    // but NOT the IP counter — otherwise one valid account could clear the
    // flood limit for the whole address.
    if (subject) subjectLimiter.reset(`subject:${subject}`);
    res.json({ mode: 'supabase', session: sessionEnvelope(data.session, data.user) });
  });

  // POST /api/auth/refresh — rotate the refresh token for a new session.
  router.post('/refresh', async (req, res) => {
    if (!auth || auth.mode !== 'supabase') return reportPrototype(req, res);

    const { refresh_token: refreshToken } = req.body ?? {};
    const subject = typeof refreshToken === 'string' && refreshToken !== ''
      ? `refresh:${fingerprint(refreshToken)}`
      : null;
    if (rateLimited(req, res, subject)) return;

    if (typeof refreshToken !== 'string' || !REFRESH_TOKEN_RE.test(refreshToken)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A refresh token is required.');
    }

    const { data, error } = await auth.refreshSession(refreshToken);
    if (error || !data?.session) {
      // Same generic outcome whichever way it fails — never says whether the
      // session or the user behind it exists.
      return res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Session expired. Sign in again.' },
      });
    }
    res.json({ mode: 'supabase', session: sessionEnvelope(data.session) });
  });

  return router;
}
