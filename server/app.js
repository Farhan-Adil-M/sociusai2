// Express app factory. `createApp({ db, ai, vector, auth })` builds the real
// app; tests pass a temporary database and stubbed ai/vector services to run
// without network. The injected dependencies and the mount paths below are the
// contract every test suite and the serverless entry rely on — keep them stable.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createUserAuth } from './middleware/auth.js';
import { chatCompletion } from './services/nimChat.js';
import { embedTexts, embedQuery } from './services/embeddings.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { sourcesRouter } from './routes/sources.js';
import { tutorRouter } from './routes/tutor.js';
import { extensionRouter } from './routes/extension.js';
import { quizRouter } from './routes/quiz.js';
import { learnerRouter } from './routes/learner.js';
import { decksRouter, flashcardsRouter } from './routes/decks.js';
import { sessionsRouter } from './routes/sessions.js';
import { profileRouter, onboardingRouter } from './routes/profile.js';
import { adaptiveRouter } from './routes/adaptive.js';
import { plannerRouter } from './routes/planner.js';
import { adviceRouter } from './routes/advice.js';
import { shareRouter } from './routes/share.js';
import { viewerRouter } from './routes/viewer.js';
import { mediaRouter } from './routes/media.js';
import { eventsRouter } from './routes/events.js';
import { resolveVectorStore } from './store/vectorProvider.js';

const FRONTEND_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../frontend');

// --- request plumbing -------------------------------------------------------

// A client-supplied id is reused only when it is a short, safe token; anything
// else gets a fresh UUID. The value is echoed in the X-Request-Id response
// header and in error envelopes so a user-visible failure can be traced.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function assignRequestId(req, res, next) {
  const inbound = req.get('x-request-id');
  req.id = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// Responses must keep their declared content type — a stray HTML error page
// served as JSON (or vice versa) is how MIME-confusion bugs start.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

// Explicit CORS allow-list: the browser extension (chrome-extension://,
// moz-extension://) and local development origins. The served frontend is
// same-origin and sends no Origin, so it needs no header. Anything else gets no
// CORS header and browsers refuse it — the policy is permissive for our own
// clients, closed for everyone else.
const ALLOWED_ORIGINS = [
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-web-extension:\/\//i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^https?:\/\/\[::1\](:\d+)?$/i,
];

function cors(req, res, next) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.append('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

// --- frontend static files --------------------------------------------------

// Serve whatever exists in frontend/ — no page list is hard-coded here, so
// Wave 3 can add pages without touching this file. An unknown path falls back
// to the landing page (which links to every other page) when it exists.
function serveFrontend(app) {
  if (!fs.existsSync(FRONTEND_DIR)) return;

  app.use(express.static(FRONTEND_DIR));
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    const safePath = path.normalize(req.path).replace(/^(\.\.[/\\])+/, '');
    const requested = path.join(FRONTEND_DIR, safePath);
    if (requested.startsWith(FRONTEND_DIR) && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
      return res.sendFile(requested);
    }
    const index = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    next();
  });
}

// --- more route modules ------------------------------------------------------
//
// These seven are mounted inline in createApp() below, like every other router
// in this file. They used to be loaded through a try/catch using a VARIABLE
// specifier — `await import(modulePath)` — which was reserved for a wave of
// routers that had not been written yet.
//
// Two reasons that had to go once the files existed:
//
//   1. A bundler cannot follow a variable specifier. On Vercel these seven
//      files were never traced into the serverless function, so all seven
//      404'd in production while working perfectly locally — planner, advice,
//      share, viewer, media, events and adaptive were all dead.
//   2. The log line read "route not yet implemented — skipped", which is an
//      accurate description of a missing FILE and a false one for a missing
//      BUNDLE, so it actively hid the cause.
//
// Static imports fix both: the bundler sees them, and a genuinely missing
// module now fails the boot loudly instead of serving a silent 404.

// --- app factory ------------------------------------------------------------

export async function createApp({ db, ai, vector, auth } = {}) {
  const services = {
    ai: { chatCompletion, embedTexts, embedQuery, ...ai },
    vector: { ...resolveVectorStore(db), ...vector },
    // Per-user auth: the real Supabase-jwt verifier by default; tests may
    // pass a stub ({ getUserFromRequest }) to explore two users / anonymous.
    auth: auth ?? createUserAuth(),
  };
  const ctx = { db, ...services };

  const app = express();
  app.disable('x-powered-by');
  app.use(assignRequestId);
  app.use(securityHeaders);
  app.use(cors);
  // JSON bodies are small (ids, questions, answers). Files arrive as multipart
  // with their own cap (`config.maxUploadMb`), so this limit stays tight.
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/health', healthRouter(ctx));
  app.use('/api/auth', authRouter(ctx));
  app.use('/api/sources', sourcesRouter(ctx));
  app.use('/api/tutor', tutorRouter(ctx));
  app.use('/api/extension', extensionRouter(ctx));
  app.use('/api/quiz', quizRouter(ctx));
  app.use('/api/learner', learnerRouter(ctx));
  app.use('/api/flashcards', flashcardsRouter(ctx));
  app.use('/api/sessions', sessionsRouter(ctx));
  app.use('/api/decks', decksRouter(ctx));
  app.use('/api/profile', profileRouter(ctx));
  app.use('/api/onboarding', onboardingRouter(ctx));

  app.use('/api/adaptive', adaptiveRouter(ctx));
  app.use('/api/planner', plannerRouter(ctx));
  app.use('/api/advice', adviceRouter(ctx));
  app.use('/api/share', shareRouter(ctx));
  app.use('/api/viewer', viewerRouter(ctx));
  app.use('/api/media', mediaRouter(ctx));
  app.use('/api/events', eventsRouter(ctx));

  serveFrontend(app);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
