// Per-user authentication (v7 ownership model).
//
// Two modes, chosen once from configuration:
//  - supabase mode (SUPABASE_URL + SUPABASE_ANON_KEY set): the
//    `Authorization: Bearer <jwt>` header is verified against Supabase Auth
//    via supabase-js getUser(); the verified auth.users id is attached to
//    every request as `req.userId` and becomes the ownership filter used by
//    every private endpoint.
//  - prototype mode (no Supabase envs — tests and the offline demo): no auth
//    exists, so every request is the fixed dev user { id: 'default' }.
//    Documented loudly here: this mode is NOT multi-user and must never be
//    reached with public access (server binds to loopback by default).
//
// Tests never network: `createApp({ auth })` accepts a full override —
// e.g. `auth: { getUserFromRequest: async (req) => ({ id: req.headers['x-test-user'] }) }`.

import { config } from '../config.js';
import { createClient } from '@supabase/supabase-js';
import { ensureProfileRow } from '../store/sqlite.js';

/** The fixed dev user id used when no Supabase auth is configured. */
export const PROTOTYPE_USER_ID = 'default';

export function createUserAuth() {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return {
      mode: 'prototype',
      async getUserFromRequest() {
        return { id: PROTOTYPE_USER_ID };
      },
    };
  }

  // Anon key on the SERVER is signed-in-user-agnostic by design: it can only
  // verify a token the user honestly presents (getUser with an explicit JWT).
  // No refresh, no persistence — a request-scoped verification only.
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return {
    mode: 'supabase',
    // Used by routes/auth.js (the extension's login/refresh). Thin wrappers:
    // same client, same non-persisting policy; callers receive the raw
    // supabase-js { data, error } shape and own the error mapping.
    async signInWithPassword({ email, password }) {
      try {
        return await supabase.auth.signInWithPassword({ email, password });
      } catch (err) {
        return { data: { session: null, user: null }, error: { message: err?.message ?? 'sign-in failed' } };
      }
    },
    async refreshSession(refreshToken) {
      try {
        return await supabase.auth.refreshSession({ refresh_token: refreshToken });
      } catch (err) {
        return { data: { session: null }, error: { message: err?.message ?? 'refresh failed' } };
      }
    },
    async getUserFromRequest(req) {
      const header = req.headers?.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (token === '') return null;
      else req.userToken = token; // storage fetches re-use the user's own JWT (RLS-safe)
      try {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user?.id) {
          // One line of diagnostics when verification fails — never the token.
          console.error('[auth] token rejected:', error?.message ?? '(no user)');
          return null;
        }
        return { id: data.user.id, token };
      } catch (err) {
        console.error('[auth] verify threw:', err?.message ?? err);
        return null; // network/auth failure → unauthenticated, never a crash
      }
    },
  };
}

// Exact 401 envelope for every private endpoint (contract: error shape only
// changes with the API contract version).
const UNAUTHENTICATED = {
  error: { code: 'UNAUTHENTICATED', message: 'Sign in to use this endpoint.' },
};

/**
 * Router-level guard. Mount FIRST on every private router:
 * `router.use(requireAuth(ctx))` — succeeds → sets `req.userId`
 * (the verified id) and next(); fails → 401 UNAUTHENTICATED before any
 * handler runs. With `db` it also bootstraps the profile row every other
 * per-user table references (pg foreign keys), so a fresh account can act
 * before it ever opens onboarding.
 */
export function requireAuth({ auth, db } = {}) {
  // One bootstrap insert per user per process — the SQL itself is an
  // idempotent ON CONFLICT DO NOTHING, so a cache miss is always safe.
  const bootstrapped = new Set();
  return async function requireAuthMiddleware(req, res, next) {
    try {
      const user = auth ? await auth.getUserFromRequest(req) : null;
      if (!user || typeof user.id !== 'string' || user.id === '') {
        return res.status(401).json(UNAUTHENTICATED);
      }
      req.userId = user.id;
      if (user.token) req.userToken = user.token;
      if (db && !bootstrapped.has(user.id)) {
        await ensureProfileRow(db, user.id);
        bootstrapped.add(user.id);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
