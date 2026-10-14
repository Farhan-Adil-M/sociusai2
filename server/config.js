// Central configuration. Reads environment variables once. Essential values
// are checked by assertConfig() at server startup (not at import time, so
// unit tests can run without a filled-in .env).

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export function assertConfig() {
  const missing = [];
  if (!config.nimApiKey) missing.push('NIM_API_KEY');
  if (missing.length > 0) {
    console.error(`\nMissing environment variable(s): ${missing.join(', ')}.\nCopy .env.example to .env and fill in real values.\n`);
    process.exit(1);
  }
}

const supabaseUrl = optional('SUPABASE_URL', '').trim();
const supabaseAnonKey = optional('SUPABASE_ANON_KEY', '').trim();
const supabaseDbUrl = optional('SUPABASE_DB_URL', '').trim();
const tursoDatabaseUrl = optional('TURSO_DATABASE_URL', '');
const tursoAuthToken = optional('TURSO_AUTH_TOKEN', '');

export const config = {
  port: Number(optional('PORT', 3000)),
  maxUploadMb: Number(optional('MAX_UPLOAD_MB', 25)),

  // Interface the HTTP server binds to. Default is loopback-only; setting a
  // LAN address (or 0.0.0.0) lets other devices on the network connect.
  // There is no authentication — only do this on a network you trust.
  bindHost: optional('BIND_HOST', '127.0.0.1'),

  // NVIDIA NIM — every value verified against our account (see docs/API_CONTRACT.md).
  nimApiKey: optional('NIM_API_KEY', ''),
  nimBaseUrl: optional('NIM_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
  nimEmbedModel: optional('NIM_EMBED_MODEL', 'nvidia/nemotron-3-embed-1b'),
  nimChatModel: optional('NIM_CHAT_MODEL', 'nvidia/nemotron-3.5-lightning-30b-a3b'),
  nimAssessModel: optional('NIM_ASSESS_MODEL', 'nvidia/nemotron-3-super-120b-a12b'),
  nimTimeoutMs: Number(optional('NIM_TIMEOUT_MS', 45000)),

  // Retrieval quality: relative cutoff + absolute sanity bound (see v1.2 notes).
  ragMinSimilarity: Number(optional('RAG_MIN_SIMILARITY', '0.1')),
  ragRelativeKeep: Number(optional('RAG_RELATIVE_KEEP', '0.5')),

  // Extension highlighter: minimum cosine similarity for a page sentence to
  // earn a highlight. Calibrated live (2026-10-14): the embedding model is
  // anisotropic — unrelated sentences still score ~0.70-0.72 against a small
  // corpus while near-verbatim study text scores ~0.92, so 0.80 separates
  // them. Tunable per deployment without a code change.
  extensionMinSimilarity: Number(optional('EXTENSION_MIN_SIMILARITY', '0.8')),

  // ChromaDB — Cloud when CHROMA_API_KEY is set, otherwise the local server.
  chromaApiKey: optional('CHROMA_API_KEY', ''),
  chromaTenant: optional('CHROMA_TENANT', ''),
  chromaDatabase: optional('CHROMA_DATABASE', ''),
  chromaCollection: optional('CHROMA_COLLECTION', 'socius_chunks'),
  chromaLocalHost: optional('CHROMA_LOCAL_HOST', 'localhost'),
  chromaLocalPort: Number(optional('CHROMA_LOCAL_PORT', 8100)),

  supabaseUrl,
  supabaseAnonKey,
  supabaseDbUrl,
  tursoDatabaseUrl,
  tursoAuthToken,
  dataDir: optional('DATA_DIR', 'data'),
};
