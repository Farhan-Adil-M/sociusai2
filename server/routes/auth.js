// POST /api/auth/login   { email, password } → the Supabase session (tokens + user)
// POST /api/auth/refresh { refresh_token }    → a fresh session
//
// These exist for the browser extension, which has no Supabase client library
// and talks to ONE base URL. The website keeps logging in directly against
// Supabase from the browser (frontend/js/auth.js) — unchanged.
//
// Sessions are real Supabase sessions (same ones the website gets), so the
// backend's existing Bearer verification (middleware/auth.js) accepts them on
// every private endpoint. Passwords and tokens are never logged.

import express from 'express';
import { ApiError } from '../middleware/errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  // Prototype mode: no auth exists. Say so instead of pretending to sign in —
  // the extension reads `mode` and hides its login UI.
  const reportPrototype = (req, res) => res.json({ mode: 'prototype' });

  // POST /api/auth/login — password grant via Supabase Auth.
  router.post('/login', async (req, res) => {
    if (!auth || auth.mode !== 'supabase') return reportPrototype(req, res);

    const { email, password } = req.body ?? {};
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
    res.json({ mode: 'supabase', session: sessionEnvelope(data.session, data.user) });
  });

  // POST /api/auth/refresh — rotate the refresh token for a new session.
  router.post('/refresh', async (req, res) => {
    if (!auth || auth.mode !== 'supabase') return reportPrototype(req, res);

    const { refresh_token: refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string' || refreshToken.length < 1) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A refresh token is required.');
    }

    const { data, error } = await auth.refreshSession(refreshToken);
    if (error || !data?.session) {
      return res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Session expired. Sign in again.' },
      });
    }
    res.json({ mode: 'supabase', session: sessionEnvelope(data.session) });
  });

  return router;
}
