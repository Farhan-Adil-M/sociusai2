// Authentication middleware + trust model for Socius AI.
//
// TRUST MODEL (read this before adding a route)
// ---------------------------------------------------------------------------
// The browser is untrusted. It never talks to ChromaDB or the NVIDIA NIM API
// directly — both are only reachable through this Node server. Every private
// endpoint under /api (everything except `GET /api/health` and the
// `POST /api/auth/*` login/refresh pair) is guarded by `requireAuth`, which
// derives the acting user id *only* from a verified Supabase JWT.
//
//   browser ──(Authorization: Bearer <supabase access token>)──▶ Express
//     Express verifies the token with Supabase Auth (auth.getUser) ─▶ req.userId
//     routes filter every row by  user_id = req.userId  ─▶ Postgres / SQLite
//
// Rules that keep this model sound:
//   - Never trust a user id from a request body, query string, or header.
//     Only the verified `req.userId` selects data.
//   - Never decode-and-trust a JWT here. Signature, issuer and expiry are
//     checked by Supabase's `getUser`; the local checks below are an
//     UNVERIFIED fast-reject filter, never a security decision.
//   - RLS policies (server/store/pg-schema.sql) are DEFENCE IN DEPTH behind
//     this middleware, not a substitute: the Node path always adds
//     `AND user_id = ?` to every user-owned query.
//   - Tokens (JWTs, refresh tokens) and passwords are never logged.
//
// Two modes, chosen once from configuration:
//  - supabase mode (SUPABASE_URL + SUPABASE_ANON_KEY set): the
//    `Authorization: Bearer <jwt>` header is verified against Supabase Auth
//    via supabase-js getUser(); the verified auth.users id is attached to
//    every request as `req.userId` and becomes the ownership filter used by
//    every private endpoint. The verified token is also attached as
//    `req.userToken` so storage calls can act with the user's own rights.
//  - prototype mode (no Supabase envs — tests and the offline demo): no auth
//    exists, so every request is the fixed dev user { id: 'default' }.
//    This mode is SINGLE-USER by construction: it logs a loud warning and is
//    refused outright when NODE_ENV=production unless explicitly forced.
//
// Tests never network: `createApp({ auth })` accepts a full override —
// e.g. `auth: { getUserFromRequest: async (req) => ({ id: req.headers['x-test-user'] }) }`.

import { config } from '../config.js';
import { createClient } from '@supabase/supabase-js';
import { ensureProfileRow } from '../store/sqlite.js';

/** The fixed dev user id used when no Supabase auth is configured. */
export const PROTOTYPE_USER_ID = 'default';

/** Env switch that allows prototype mode even under NODE_ENV=production. */
const ALLOW_PROTOTYPE_ENV = 'ALLOW_PROTOTYPE_AUTH';

/**
 * Prototype mode is a single-user, no-auth mode. Refuse to start with it in
 * production unless the operator has explicitly opted in — a silent downgrade
 * to "everyone shares one account" must never happen by accident.
 */
function assertPrototypeAllowed() {
  const isProduction = (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const forced = (process.env[ALLOW_PROTOTYPE_ENV] ?? '').trim().toLowerCase() === 'true';
  if (isProduction && !forced) {
    throw new Error(
      '[auth] Refusing to start: SUPABASE_URL / SUPABASE_ANON_KEY are not set and '
      + 'NODE_ENV=production. Prototype mode has NO authentication and a single shared '
      + `user — it is blocked in production. Configure Supabase, or set ${ALLOW_PROTOTYPE_ENV}=true `
      + 'to override deliberately (unsafe: disable the internet-facing surface first).',
    );
  }
}

// One warning per process: createUserAuth() runs at startup, and tests call it
// many times. Repeating it would drown the log for no benefit.
let prototypeWarned = false;
function warnPrototypeOnce() {
  if (prototypeWarned) return;
  prototypeWarned = true;
  console.warn(
    '[auth] PROTOTYPE MODE: authentication is DISABLED. Every request is treated as the '
    + `single shared user "${PROTOTYPE_USER_ID}". This is a single-user demo mode — never `
    + 'expose it beyond a trusted machine. Set SUPABASE_URL + SUPABASE_ANON_KEY for real accounts.',
  );
}

// --- unverified JWT pre-filter --------------------------------------------
//
// These helpers read a token WITHOUT trusting it. They exist only to fail fast
// on requests that could never verify (malformed, alg:"none", expired), saving
// a network round-trip to Supabase. The authoritative decision is always the
// `auth.getUser(token)` call below.

/** Clock skew allowed before an unverified `exp` is treated as expired. */
const JWT_SKEW_SECONDS = 60;

function decodeJsonSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Decode a token's header/payload WITHOUT verifying the signature.
 * Returns `{ alg, exp }` for a well-formed `header.payload.signature` JWS, or
 * `null` when the token is not even shaped like one. Never throws.
 */
export function inspectUnverifiedToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  const header = decodeJsonSegment(parts[0]);
  if (!header || typeof header !== 'object') return null;
  const payload = decodeJsonSegment(parts[1]);
  return {
    alg: typeof header.alg === 'string' ? header.alg : null,
    exp: payload && typeof payload.exp === 'number' ? payload.exp : null,
  };
}

/**
 * True when a well-formed, non-expired-looking token should be sent to the
 * verifier. Malformed tokens, `alg: "none"`, and clearly expired tokens are
 * rejected here; everything else is delegated to Supabase.
 *
 * NOTE: `alg: "HS256"` is deliberately NOT rejected. Legacy Supabase projects
 * sign access tokens with HS256, and Supabase's own verifier prevents
 * algorithm-confusion attacks. We do not implement our own signature check,
 * so there is nothing for an attacker to confuse.
 */
function passesPreFilter(token) {
  const claims = inspectUnverifiedToken(token);
  if (!claims || claims.alg === 'none') return false;
  if (claims.alg === null) return false; // a JWT with no alg is not valid
  if (claims.exp !== null && claims.exp + JWT_SKEW_SECONDS < Date.now() / 1000) return false;
  return true;
}

export function createUserAuth() {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    assertPrototypeAllowed();
    warnPrototypeOnce();
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

      // Fast-reject before any network call. `passesPreFilter` never trusts the
      // token; a forged token that slips through still has to verify below.
      if (!passesPreFilter(token)) {
        console.error('[auth] token rejected: malformed, unsecured or expired');
        return null;
      }

      try {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data?.user?.id) {
          // One line of diagnostics when verification fails — never the token.
          console.error('[auth] token rejected:', error?.message ?? '(no user)');
          return null;
        }
        // `token` is attached to req by requireAuth only AFTER this success,
        // so an unverified token is never exposed on the request.
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
 * (the verified id) and `req.userToken` (the verified JWT, when the verifier
 * supplies one) and next(); fails → 401 UNAUTHENTICATED before any
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
