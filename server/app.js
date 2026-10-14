// Express app factory. `createApp({ db })` builds the real app; tests pass a
// temporary database and stubbed ai/vector services to run without network.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
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

  // Serve the frontend built by Freebuff (same origin → no CORS anywhere).
  if (fs.existsSync(FRONTEND_DIR)) {
    app.use(express.static(FRONTEND_DIR));
    app.get(/^\/(?!api\/).*/, (req, res, next) => {
      const requested = path.join(FRONTEND_DIR, path.normalize(req.path).replace(/^(\.\.[/\\])+/, ''));
      if (requested.startsWith(FRONTEND_DIR) && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
        return res.sendFile(requested);
      }
      // Unknown page → serve the landing page; it links to every other page.
      const index = path.join(FRONTEND_DIR, 'index.html');
      if (fs.existsSync(index)) return res.sendFile(index);
      next();
    });
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
