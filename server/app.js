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

// --- Wave 4 route modules ---------------------------------------------------

// These routers are owned by Wave 4 and do not exist yet. They are imported
// dynamically, in a try/catch, so a missing module logs one line and startup
// continues instead of crashing. Adding the file is the only step Wave 4 needs:
// no edit to this file.
const RESERVED_ROUTES = [
  ['/api/adaptive', './routes/adaptive.js', 'adaptiveRouter'],
  ['/api/planner', './routes/planner.js', 'plannerRouter'],
  ['/api/advice', './routes/advice.js', 'adviceRouter'],
  ['/api/share', './routes/share.js', 'shareRouter'],
  ['/api/viewer', './routes/viewer.js', 'viewerRouter'],
  ['/api/media', './routes/media.js', 'mediaRouter'],
  ['/api/events', './routes/events.js', 'eventsRouter'],
];

// Report each missing route once per process; test runs create many app
// instances and should not repeat the same line hundreds of times.
const reportedMissingRoutes = new Set();

async function mountReservedRoutes(app, ctx) {
  for (const [mountPath, modulePath, exportName] of RESERVED_ROUTES) {
    let factory;
    try {
      const mod = await import(modulePath);
      factory = mod[exportName];
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        if (!reportedMissingRoutes.has(mountPath)) {
          reportedMissingRoutes.add(mountPath);
          console.log(`[routes] route ${mountPath} not yet implemented — skipped`);
        }
        continue;
      }
      // The module exists but failed to load (or threw while importing): keep
      // booting, but say so loudly — this is a real bug, not a wave gap.
      console.error(`[routes] failed to load ${modulePath} for ${mountPath}: ${err?.message ?? err}`);
      continue;
    }
    if (typeof factory !== 'function') {
      console.error(`[routes] ${modulePath} does not export ${exportName}() — skipping ${mountPath}`);
      continue;
    }
    app.use(mountPath, factory(ctx));
  }
}

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

  await mountReservedRoutes(app, ctx);

  serveFrontend(app);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
