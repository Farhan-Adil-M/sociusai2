// GET /api/health — liveness + dependency status. Always 200 while the server
// runs; degraded dependencies are reported inside the payload, never as a crash.

import express from 'express';
import { config } from '../config.js';
import { getMeta } from '../store/sqlite.js';
import { chatCompletion } from '../services/nimChat.js';
import { embedQuery } from '../services/embeddings.js';

// Health caching: the NIM probe is a PAID embedding request, so a fresh probe
// runs at most once every 10 minutes. Between probes the cached verdict is
// reported as-is — semantics: "known good within cache window", never a claim
// that the model is reachable right now.
const CACHE_MS = 10 * 60 * 1000;

export function healthRouter({ db, ai, vector }) {
  const router = express.Router();
  let cached = { at: 0, payload: null };

  router.get('/', async (req, res) => {
    if (cached.payload && Date.now() - cached.at < CACHE_MS) {
      return res.json(cached.payload);
    }

    const checks = { sqlite: { ok: false, message: '' }, chroma: { ok: false, message: '' }, nim: { ok: false, message: '' } };
    const authMode = config.supabaseUrl && config.supabaseAnonKey ? 'supabase' : 'prototype'; // public facts read by the browser
    // Publish the PUBLIC auth config only (URL + anon key are safe in the
    // browser; no service-role or DB credentials ever leave the server).
    const authPublic = config.supabaseUrl && config.supabaseAnonKey
      ? { mode: 'supabase', supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey }
      : { mode: 'prototype' };

    try {
      await db.get('SELECT 1 AS ok');
      checks.sqlite.ok = true;
    } catch (err) {
      checks.sqlite.message = 'Local database is not readable.';
    }

    // Which storage engine answered: 'node' (local file) or 'libsql' (hosted).
    // Additive field — A3's upload-limit block below stays untouched.
    if (checks.sqlite.ok) checks.sqlite.backend = db.kind;

    try {
      await (vector?.pingChroma ?? (await import('../store/vectorStore.js')).pingChroma)();
      checks.chroma.ok = true;
      checks.chroma.backend = vector?.backend ?? 'chroma'; // 'chroma' | 'sqlite' fallback
    } catch (err) {
      checks.chroma.message = 'Vector database unreachable. Start the local Chroma server or check CHROMA_* in .env.';
    }

    try {
      await (ai?.embedQuery ?? embedQuery)('health check');
      checks.nim.ok = true;
      checks.nim.chatModel = config.nimChatModel;
      checks.nim.embeddingModel = config.nimEmbedModel;
    } catch (err) {
      checks.nim.message = err.message || 'AI provider unreachable.';
    }

    // Embedding-model guard (contract §Rebuilding): warn when the running
    // index was built with a different model than the configured one.
    if (checks.sqlite.ok && checks.nim.ok) {
      const storedModel = await getMeta(db, 'embed_model');
      if (storedModel && storedModel !== config.nimEmbedModel) {
        checks.nim.ok = false;
        checks.nim.message = `The vector index was built with "${storedModel}" but NIM_EMBED_MODEL is "${config.nimEmbedModel}" — run npm run reindex before ingesting or asking questions.`;
      }
    }

    // Static fact, not a service probe. The status rollup is computed from the
    // three service checks BEFORE limits is added, so this can never mark the
    // system degraded. The frontend reads checks.auth.mode and
    // checks.limits.maxUploadMb to show the real upload cap instead of a
    // hardcoded number.
    const status = Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded';
    checks.auth = authPublic;
    checks.limits = { maxUploadMb: config.maxUploadMb };

    const payload = {
      status,
      checks,
    };
    cached = { at: Date.now(), payload };
    res.json(payload);
  });

  return router;
}
