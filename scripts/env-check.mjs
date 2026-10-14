#!/usr/bin/env node
// scripts/env-check.mjs — verify that an environment can actually run Socius AI.
//
// Run it directly (it is not wired into package.json; see docs/HANDOFF.md):
//
//   node scripts/env-check.mjs                  check this machine (reads .env)
//   node scripts/env-check.mjs --env-file PATH  check a specific env file
//   node scripts/env-check.mjs --no-env-file    check ONLY the process env
//
// What it does:
//   * reports every variable the code reads — present / empty / not set — BY
//     NAME with a safe indicator (length + a short sha256 fingerprint). It
//     never prints a value, token, key, or database password. A URL is reduced
//     to its scheme + host, so a Postgres connection string cannot leak the
//     password it carries.
//   * distinguishes development from production. Production is detected from
//     the platform's own signals (VERCEL=1 or NODE_ENV=production). There,
//     Supabase Postgres + Chroma Cloud are mandatory and the SQLite /
//     local-Chroma fallbacks are refused: Vercel has no persistent filesystem,
//     so a deployment on them would silently lose every account and source.
//   * validates cheap formats (URL shape, JWT shape, positive numbers,
//     booleans) and flags obvious placeholder values such as "your-key-here".
//   * warns loudly when the configured store cannot persist where it is
//     running (SQLITE_DB_PATH under a serverless filesystem, for example).
//   * exits 1 with an actionable message when the environment cannot work,
//     and exits 0 with a summary when it can.
//
// Uses only Node built-ins — no new npm dependency.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ENV_FILE = path.join(REPO_ROOT, '.env');

// ---------------------------------------------------------------------------
// The contract. One row per variable the code actually reads (derived from
// server/config.js, server/store/*, server/middleware/auth.js,
// server/routes/{auth,sources,share,media}.js, server/services/media/* and
// scripts/* — not from memory).
//
//   need: 'always'   required in development AND production
//        'prod'      required only in production (see the note on each row)
//        'optional'  has a working default; the app runs without it
//        'platform'  set by Vercel/the shell — never put these in .env
//
//   kind: how the value looks, used only for the safe indicator + a cheap
//         format check. It never changes what is printed.
// ---------------------------------------------------------------------------
const CONTRACT = [
  // --- NVIDIA NIM (the only AI provider) ---
  { name: 'NIM_API_KEY', need: 'always', kind: 'key', note: 'the only AI provider; server/index.js exits without it' },
  { name: 'NIM_BASE_URL', need: 'optional', kind: 'url', note: 'default https://integrate.api.nvidia.com/v1' },
  { name: 'NIM_EMBED_MODEL', need: 'optional', kind: 'text', note: 'default nvidia/nemotron-3-embed-1b' },
  { name: 'NIM_CHAT_MODEL', need: 'optional', kind: 'text', note: 'default nvidia/nemotron-3.5-lightning-30b-a3b' },
  { name: 'NIM_ASSESS_MODEL', need: 'optional', kind: 'text', note: 'default nvidia/nemotron-3-super-120b-a12b' },
  { name: 'NIM_TIMEOUT_MS', need: 'optional', kind: 'number', note: 'default 45000' },

  // --- task → model overrides (aiRouter) ---
  { name: 'AI_TUTOR_MODEL', need: 'optional', kind: 'text', note: 'overrides NIM_CHAT_MODEL when set' },
  { name: 'AI_ASSESS_MODEL', need: 'optional', kind: 'text', note: 'overrides NIM_ASSESS_MODEL when set' },
  { name: 'AI_EMBED_MODEL', need: 'optional', kind: 'text', note: 'overrides NIM_EMBED_MODEL when set' },

  // --- retrieval quality ---
  { name: 'RAG_MIN_SIMILARITY', need: 'optional', kind: 'number', note: 'default 0.1' },
  { name: 'RAG_RELATIVE_KEEP', need: 'optional', kind: 'number', note: 'default 0.5' },
  { name: 'EXTENSION_MIN_SIMILARITY', need: 'optional', kind: 'number', note: 'default 0.8 (extension highlighter)' },

  // --- Supabase: accounts + durable storage ---
  { name: 'SUPABASE_URL', need: 'prod', kind: 'url', note: 'real accounts; without it production boots in no-auth prototype mode' },
  { name: 'SUPABASE_ANON_KEY', need: 'prod', kind: 'sbkey', note: 'browser key used to verify sign-in tokens' },
  { name: 'SUPABASE_DB_URL', need: 'prod', kind: 'url', note: 'Postgres connection string (schema v8, already migrated)' },
  { name: 'TURSO_DATABASE_URL', need: 'optional', kind: 'url', note: 'alternative hosted engine when Supabase is not used' },
  { name: 'TURSO_AUTH_TOKEN', need: 'optional', kind: 'key', note: 'required whenever TURSO_DATABASE_URL is set' },

  // --- Chroma: the vector store ---
  { name: 'CHROMA_API_KEY', need: 'prod', kind: 'key', note: 'Chroma Cloud; no local Chroma server exists on Vercel' },
  { name: 'CHROMA_TENANT', need: 'optional', kind: 'text', note: 'Chroma Cloud tenant (optional)' },
  { name: 'CHROMA_DATABASE', need: 'optional', kind: 'text', note: 'Chroma Cloud database (optional)' },
  { name: 'CHROMA_COLLECTION', need: 'optional', kind: 'text', note: 'default socius_chunks' },
  { name: 'CHROMA_LOCAL_HOST', need: 'optional', kind: 'text', note: 'default localhost — local fallback server only' },
  { name: 'CHROMA_LOCAL_PORT', need: 'optional', kind: 'number', note: 'default 8100 — local fallback server only' },
  { name: 'VECTOR_STORE', need: 'optional', kind: 'text', note: 'chroma | sqlite; unset = automatic choice' },

  // --- local database paths ---
  { name: 'SQLITE_DB_PATH', need: 'optional', kind: 'path', note: 'local engine path; on Vercel it is ephemeral /tmp' },
  { name: 'DATA_DIR', need: 'optional', kind: 'path', note: 'default data' },

  // --- server ---
  { name: 'PORT', need: 'optional', kind: 'number', note: 'default 3000' },
  { name: 'MAX_UPLOAD_MB', need: 'optional', kind: 'number', note: 'default 25' },
  { name: 'BIND_HOST', need: 'optional', kind: 'text', note: 'default 127.0.0.1 (this machine only)' },

  // --- uploads ---
  { name: 'MAX_STORAGE_UPLOAD_MB', need: 'optional', kind: 'number', note: 'default 25 (direct-to-Storage path)' },
  { name: 'ZIP_MAX_UNCOMPRESSED_MB', need: 'optional', kind: 'number', note: 'default 100 (Office zip-bomb guard)' },

  // --- auth ---
  { name: 'ALLOW_PROTOTYPE_AUTH', need: 'optional', kind: 'bool', note: 'escape hatch for no-auth mode in production — never on the internet' },
  { name: 'AUTH_RATE_WINDOW_MS', need: 'optional', kind: 'number', note: 'default 900000 (15 min)' },
  { name: 'AUTH_RATE_MAX_IP', need: 'optional', kind: 'number', note: 'default 30' },
  { name: 'AUTH_RATE_MAX_SUBJECT', need: 'optional', kind: 'number', note: 'default 8' },

  // --- media ---
  { name: 'YOUTUBE_API_KEY', need: 'optional', kind: 'key', note: 'unused: /api/media/youtube reads captions without a key' },
  { name: 'OCR_ENGINE', need: 'optional', kind: 'text', note: 'default tesseract' },
  { name: 'VIEWER_MAX_MB', need: 'optional', kind: 'number', note: 'default 25 (in-app viewer)' },
  { name: 'YOUTUBE_TIMEOUT_MS', need: 'optional', kind: 'number', note: 'default 15000' },
  { name: 'YOUTUBE_SEGMENT_SECONDS', need: 'optional', kind: 'number', note: 'default 30' },
  { name: 'YOUTUBE_SEGMENT_MAX_CHARS', need: 'optional', kind: 'number', note: 'default 600' },
  { name: 'YOUTUBE_MAX_TRACK_BYTES', need: 'optional', kind: 'number', note: 'default 16 (MB)' },
  { name: 'OCR_TIMEOUT_MS', need: 'optional', kind: 'number', note: 'default 45000' },
  { name: 'OCR_MAX_FILE_MB', need: 'optional', kind: 'number', note: 'default 25' },
  { name: 'OCR_MAX_PIXELS', need: 'optional', kind: 'number', note: 'default 40000000 (40 MP)' },
  { name: 'OCR_LANG_PATH', need: 'optional', kind: 'path', note: 'directory holding eng.traineddata' },
  { name: 'OCR_LANG_CACHE', need: 'optional', kind: 'path', note: 'where OCR language data may be cached' },

  // --- sharing ---
  { name: 'SHARE_FETCH_TIMEOUT_MS', need: 'optional', kind: 'number', note: 'default 15000' },
  { name: 'SHARE_ALLOW_PRIVATE_HOSTS', need: 'optional', kind: 'bool', note: 'sandbox-only SSRF escape hatch — never true in production' },

  // --- local scripts ---
  { name: 'EVAL_BASE_URL', need: 'optional', kind: 'url', note: 'default http://localhost:3000' },
  { name: 'SMOKE_BASE_URL', need: 'optional', kind: 'url', note: 'default http://localhost:3000' },
  { name: 'E2E_BASE_URL', need: 'optional', kind: 'url', note: 'default http://127.0.0.1:7000' },
  { name: 'E2E_U1_EMAIL', need: 'optional', kind: 'text', note: 'e2e/auth scripts only' },
  { name: 'E2E_U1_PASSWORD', need: 'optional', kind: 'secret', note: 'e2e/auth scripts only' },
  { name: 'E2E_U2_EMAIL', need: 'optional', kind: 'text', note: 'e2e/auth scripts only' },
  { name: 'E2E_U2_PASSWORD', need: 'optional', kind: 'secret', note: 'e2e/auth scripts only' },

  // --- set by the platform, not by .env ---
  { name: 'VERCEL', need: 'platform', kind: 'text', note: '=1 on every Vercel function invocation' },
  { name: 'NODE_ENV', need: 'platform', kind: 'text', note: '=production in a Vercel production build' },
];

const KNOWN_NAMES = new Set(CONTRACT.map((row) => row.name));

// Values that mean "I copied the example and forgot to fill this in".
const PLACEHOLDER = /\b(your[-_ ]?[a-z0-9_-]*|replace[-_ ]?me|change[-_ ]?me|placeholder|insert[-_ ]?[a-z]+|xxxx+|<[a-z_ -]+>|example\.(com|supabase\.co)|\btodo\b|\bredacted\b)/i;

// ---------------------------------------------------------------------------
// tiny .env reader (same rules as Node's --env-file: no shell expansion, no
// comments after a value, quotes are stripped, an existing environment
// variable is never overwritten)
// ---------------------------------------------------------------------------
function parseEnvFile(text) {
  const out = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.set(name, value);
  }
  return out;
}

function readArgs(argv) {
  const opts = { envFile: null, noEnvFile: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-env-file') opts.noEnvFile = true;
    else if (arg === '--env-file') { opts.envFile = argv[i + 1]; i += 1; }
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else opts.unknown = arg;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// safe reporting helpers — a value NEVER reaches the terminal
// ---------------------------------------------------------------------------
function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** A one-line description of a value that cannot be reversed into the value. */
function indicator(kind, value) {
  const length = value.length;
  if (kind === 'url') {
    try {
      const url = new URL(value);
      const credentials = url.username !== '' || url.password !== '';
      // url.host excludes the userinfo, so a Postgres password never shows.
      return `url → ${url.protocol}//${url.host}${credentials ? ' (credentials hidden)' : ''} · ${length} chars · fp:${fingerprint(value)}`;
    } catch { /* not a URL — fall through to the generic form */ }
  }
  if (kind === 'sbkey') {
    // Supabase ships two shapes: the legacy anon key (a 3-segment JWT) and
    // the newer publishable key (`sb_publishable_…`). Both are safe in a
    // browser; neither is printed here.
    if (value.startsWith('sb_publishable_')) return `publishable key (sb_publishable_…) · ${length} chars · fp:${fingerprint(value)}`;
    if (value.startsWith('sb_secret_')) return `secret key (sb_secret_…) · ${length} chars · fp:${fingerprint(value)}`;
    const segments = value.split('.').length;
    return segments === 3
      ? `anon key · jwt · 3 segments · ${length} chars · fp:${fingerprint(value)}`
      : `unrecognised shape · ${length} chars · fp:${fingerprint(value)}`;
  }
  if (kind === 'jwt') {
    const segments = value.split('.').length;
    return segments === 3
      ? `jwt · 3 segments · ${length} chars · fp:${fingerprint(value)}`
      : `expected a 3-segment JWT, found ${segments} segment(s) · ${length} chars · fp:${fingerprint(value)}`;
  }
  if (kind === 'key' || kind === 'secret') {
    return `set · ${length} chars · fp:${fingerprint(value)}`;
  }
  if (kind === 'bool') {
    return `"${value}" (read as ${String(value).trim().toLowerCase() === 'true' ? 'on' : 'off'})`;
  }
  return `set · ${length} chars · fp:${fingerprint(value)}`;
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------
const report = [];
function add(level, message) { report.push({ level, message }); }

function asNumber(value) {
  const trimmed = String(value).trim();
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) return null;
  return Number(trimmed);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}

/** Best-effort: can this machine reach the local Chroma server? */
function probeLocalChroma(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(300, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => done(true));
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const opts = readArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/env-check.mjs [--env-file PATH] [--no-env-file]');
    return 0;
  }

  // --- resolve the environment: the real process env wins, exactly as
  // `node --env-file=.env` behaves. Otherwise the app would be checked against
  // a file it is not actually running with.
  let envFile = null;
  let envFileError = null;
  if (!opts.noEnvFile) {
    const target = opts.envFile ? path.resolve(opts.envFile) : DEFAULT_ENV_FILE;
    try {
      envFile = { path: target, values: parseEnvFile(fs.readFileSync(target, 'utf8')) };
    } catch (err) {
      envFileError = err?.code === 'ENOENT'
        ? `no file at ${target}`
        : `could not read ${target} (${err?.message ?? err})`;
    }
  }

  const get = (name) => {
    const ambient = process.env[name];
    if (ambient !== undefined && ambient.trim() !== '') return { value: ambient.trim(), from: 'process env' };
    if (envFile?.values.has(name)) {
      const value = envFile.values.get(name).trim();
      if (value !== '') return { value, from: `.env` };
    }
    return { value: '', from: 'not set' };
  };

  // --- production detection: only the platform's own signals count. A
  // developer's laptop is never mistaken for a deployment.
  const vercel = (process.env.VERCEL ?? '').trim() === '1';
  const nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  const production = vercel || nodeEnv === 'production';
  const mode = production ? 'production' : 'development';
  const modeWhy = vercel
    ? 'VERCEL=1 (running on Vercel)'
    : production ? 'NODE_ENV=production' : 'VERCEL unset and NODE_ENV unset (a local machine)';

  // --- header -------------------------------------------------------------
  const rule = '─'.repeat(78);
  console.log('Socius AI — environment check');
  console.log(rule);
  console.log(`  mode        ${mode}  — ${modeWhy}`);
  console.log(`  env file    ${envFile ? `${path.relative(process.cwd(), envFile.path)} — ${envFile.values.size} variable(s) read (values never printed)` : envFileError ?? 'skipped (--no-env-file)'}`);
  console.log(`  resolution  the process environment wins over the file, the same way "node --env-file=.env" behaves`);
  if (opts.unknown) add('ERROR', `Unknown argument "${opts.unknown}". Run with --help.`);

  // --- per-variable report -------------------------------------------------
  const present = [];
  const groups = [
    ['NVIDIA NIM — the only AI provider', ['NIM_API_KEY', 'NIM_BASE_URL', 'NIM_EMBED_MODEL', 'NIM_CHAT_MODEL', 'NIM_ASSESS_MODEL', 'NIM_TIMEOUT_MS', 'AI_TUTOR_MODEL', 'AI_ASSESS_MODEL', 'AI_EMBED_MODEL']],
    ['Retrieval quality', ['RAG_MIN_SIMILARITY', 'RAG_RELATIVE_KEEP', 'EXTENSION_MIN_SIMILARITY']],
    ['Supabase — accounts + durable database', ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_DB_URL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']],
    ['ChromaDB — the vector store', ['CHROMA_API_KEY', 'CHROMA_TENANT', 'CHROMA_DATABASE', 'CHROMA_COLLECTION', 'CHROMA_LOCAL_HOST', 'CHROMA_LOCAL_PORT', 'VECTOR_STORE']],
    ['Local database paths', ['SQLITE_DB_PATH', 'DATA_DIR']],
    ['Server', ['PORT', 'MAX_UPLOAD_MB', 'BIND_HOST', 'MAX_STORAGE_UPLOAD_MB', 'ZIP_MAX_UNCOMPRESSED_MB']],
    ['Authentication', ['ALLOW_PROTOTYPE_AUTH', 'AUTH_RATE_WINDOW_MS', 'AUTH_RATE_MAX_IP', 'AUTH_RATE_MAX_SUBJECT']],
    ['Media (YouTube captions + image OCR)', ['YOUTUBE_API_KEY', 'OCR_ENGINE', 'VIEWER_MAX_MB', 'YOUTUBE_TIMEOUT_MS', 'YOUTUBE_SEGMENT_SECONDS', 'YOUTUBE_SEGMENT_MAX_CHARS', 'YOUTUBE_MAX_TRACK_BYTES', 'OCR_TIMEOUT_MS', 'OCR_MAX_FILE_MB', 'OCR_MAX_PIXELS', 'OCR_LANG_PATH', 'OCR_LANG_CACHE']],
    ['Sharing', ['SHARE_FETCH_TIMEOUT_MS', 'SHARE_ALLOW_PRIVATE_HOSTS']],
    ['Local scripts', ['EVAL_BASE_URL', 'SMOKE_BASE_URL', 'E2E_BASE_URL', 'E2E_U1_EMAIL', 'E2E_U1_PASSWORD', 'E2E_U2_EMAIL', 'E2E_U2_PASSWORD']],
    ['Platform variables (set by Vercel/shell — never in .env)', ['VERCEL', 'NODE_ENV']],
  ];

  const byName = new Map(CONTRACT.map((row) => [row.name, row]));
  const envState = new Map(); // name → { value, from }
  for (const row of CONTRACT) envState.set(row.name, get(row.name));

  console.log('');
  for (const [title, names] of groups) {
    console.log(`  ${title}`);
    for (const name of names) {
      const row = byName.get(name);
      const { value, from } = envState.get(name);
      if (value !== '') {
        present.push(name);
        const tag = row.need === 'prod' && !production ? 'ok* ' : 'ok  ';
        console.log(`    ${tag}${name.padEnd(24)} ${indicator(row.kind, value)}`);
      } else if (row.need === 'always' || row.need === 'prod') {
        // required in this mode but absent — reported in full below
        console.log(`    --  ${name.padEnd(24)} NOT SET (required in ${row.need === 'always' ? 'every environment' : 'production'})`);
      } else {
        console.log(`    ..  ${name.padEnd(24)} not set — ${row.note}`);
      }
    }
    console.log('');
  }

  // --- required variables --------------------------------------------------
  // The specific checks below run first; a variable they already explain in
  // full does not get a second, vaguer line here.
  const missingAlways = CONTRACT.filter((r) => r.need === 'always' && envState.get(r.name).value === '').map((r) => r.name);
  const missingProd = production
    ? CONTRACT.filter((r) => r.need === 'prod' && envState.get(r.name).value === '').map((r) => r.name)
    : [];

  // --- placeholder + format checks ----------------------------------------
  for (const name of present) {
    const row = byName.get(name);
    const { value } = envState.get(name);
    if (PLACEHOLDER.test(value)) {
      // The value is NOT echoed: a message that names the variable is already
      // actionable, and echoing it could leak a real secret by accident.
      add('ERROR', `${name} still holds an unfilled placeholder (it matches the .env.example text pattern, e.g. "your-key-here" or "REPLACE_ME"). Paste the real value before deploying.`);
      continue;
    }
    switch (row.kind) {
      case 'url':
        if (!isHttpUrl(value) && name !== 'SUPABASE_DB_URL') {
          add('ERROR', `${name} is not a valid http(s) URL. Found ${value.length} characters that do not parse as a URL.`);
        }
        if (name === 'SUPABASE_DB_URL' && !/^postgres(ql)?:\/\//i.test(value)) {
          add('ERROR', `${name} must be a postgres:// or postgresql:// connection string.`);
        }
        if (production && name !== 'NIM_BASE_URL' && /^http:\/\//i.test(value) && !/127\.0\.0\.1|localhost/.test(value)) {
          add('ERROR', `${name} is plain http but this is a production environment — use https, or the tokens and passwords in it cross the network in the clear.`);
        }
        break;
      case 'sbkey':
        if (!value.startsWith('sb_publishable_') && !value.startsWith('sb_secret_') && value.split('.').length !== 3) {
          add('ERROR', `${name} is neither a legacy 3-segment anon JWT nor a "sb_publishable_…" key. Copy it from Supabase → Project Settings → API.`);
        }
        break;
      case 'jwt':
        if (value.split('.').length !== 3) {
          add('ERROR', `${name} does not look like a Supabase anon key (expected a 3-segment JWT). Copy it from Supabase → Project Settings → API.`);
        }
        break;
      case 'number': {
        const n = asNumber(value);
        if (n === null || n <= 0) add('ERROR', `${name} must be a positive number, found "${value}".`);
        else if ((name === 'RAG_MIN_SIMILARITY' || name === 'RAG_RELATIVE_KEEP' || name === 'EXTENSION_MIN_SIMILARITY') && n > 1) {
          add('ERROR', `${name} is a ratio between 0 and 1, found ${value}.`);
        }
        break;
      }
      case 'bool':
        if (!/^(true|false|1|0|yes|no|on|off)$/i.test(value)) add('ERROR', `${name} should be true or false, found "${value}".`);
        break;
      default:
        break;
    }
  }

  // Soft shape hints that are not worth failing a boot over.
  if (envState.get('NIM_API_KEY').value !== '' && !envState.get('NIM_API_KEY').value.startsWith('nvapi-')) {
    add('WARN', 'NIM_API_KEY does not start with "nvapi-" — NVIDIA keys usually do, so double-check you pasted the whole key.');
  }
  if (envState.get('NIM_BASE_URL').value !== '' && !/^https:\/\//i.test(envState.get('NIM_BASE_URL').value)) {
    add('WARN', 'NIM_BASE_URL is not https; the API key would be sent in the clear.');
  }
  if (envState.get('VECTOR_STORE').value !== '' && !/^(chroma|sqlite)$/i.test(envState.get('VECTOR_STORE').value)) {
    add('WARN', `VECTOR_STORE must be "chroma" or "sqlite"; any other value is treated as unset (the automatic choice).`);
  }

  // --- companion pairs (config refuses to boot when only one half is set) ---
  const supabaseUrl = envState.get('SUPABASE_URL').value;
  const supabaseKey = envState.get('SUPABASE_ANON_KEY').value;
  const tursoUrl = envState.get('TURSO_DATABASE_URL').value;
  const tursoToken = envState.get('TURSO_AUTH_TOKEN').value;
  if (supabaseUrl !== '' && supabaseKey === '') {
    add('ERROR', 'SUPABASE_URL is set but SUPABASE_ANON_KEY is not — the server cannot verify sign-in tokens and keeps failing closed. Set both (or neither, for prototype mode).');
  }
  if (supabaseKey !== '' && supabaseUrl === '') {
    add('ERROR', 'SUPABASE_ANON_KEY is set but SUPABASE_URL is not — set both, or neither for prototype mode.');
  }
  if (tursoUrl !== '' && tursoToken === '') {
    add('ERROR', 'TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is not; server/store/db.js refuses to open a hosted database without its token.');
  }

  // --- the persistence contract (the reason this script exists) ------------
  const durableDb = envState.get('SUPABASE_DB_URL').value !== '' || tursoUrl !== '';
  const sqlitePath = envState.get('SQLITE_DB_PATH').value;
  const chromaKey = envState.get('CHROMA_API_KEY').value;

  if (production) {
    if (!durableDb) {
      add('ERROR', 'No durable database is configured (SUPABASE_DB_URL, or TURSO_DATABASE_URL). On Vercel the local SQLite engine writes to /tmp, which is discarded on every cold start — accounts, sources, quizzes and decks would silently disappear. Set SUPABASE_DB_URL.');
    } else if (sqlitePath !== '') {
      add('WARN', `SQLITE_DB_PATH is set ("${sqlitePath}") but a hosted database is configured, so the hosted engine wins and this path is ignored.`);
    }
    if (sqlitePath !== '' && !durableDb && !/^\/tmp(\/|$)/.test(sqlitePath)) {
      add('ERROR', `SQLITE_DB_PATH is "${sqlitePath}" but Vercel only allows writes under /tmp — the serverless entry (api/index.js) would fail to open the database at cold start. Use SUPABASE_DB_URL instead.`);
    }
    if (chromaKey === '') {
      add('ERROR', 'CHROMA_API_KEY is not set. There is no local Chroma server on Vercel, so without Chroma Cloud the app falls back to the SQLite vector table — which on Vercel is also ephemeral. Set CHROMA_API_KEY (plus CHROMA_TENANT / CHROMA_DATABASE if your account needs them).');
    } else if (envState.get('CHROMA_TENANT').value === '' && envState.get('CHROMA_DATABASE').value === '') {
      add('WARN', 'CHROMA_API_KEY is set without CHROMA_TENANT / CHROMA_DATABASE — fine if the account has a single default tenant and database; otherwise the client cannot find the collection.');
    }
    if (envState.get('ALLOW_PROTOTYPE_AUTH').value.toLowerCase() === 'true') {
      add('DANGER', 'ALLOW_PROTOTYPE_AUTH=true in production: authentication is DISABLED and every request is the single user "default". Only acceptable on a private, non-internet deployment.');
    }
    if (envState.get('SHARE_ALLOW_PRIVATE_HOSTS').value.toLowerCase() === 'true') {
      add('DANGER', 'SHARE_ALLOW_PRIVATE_HOSTS=true in production lets the server fetch from localhost and private addresses when a link is shared. Never enable this on an internet-facing deployment.');
    }
  } else {
    // development
    if (!durableDb && sqlitePath !== '' && !/^(\/|data\/|\.\/|app\.db)/.test(sqlitePath) && !/^[A-Za-z]:\\/.test(sqlitePath)) {
      add('WARN', `SQLITE_DB_PATH is "${sqlitePath}" — an absolute path outside this project. Use a project-relative path (data/app.db) so the database is easy to find and to back up.`);
    }
    if (chromaKey === '') {
      const host = envState.get('CHROMA_LOCAL_HOST').value || 'localhost';
      const port = asNumber(envState.get('CHROMA_LOCAL_PORT').value) || 8100;
      const reachable = await probeLocalChroma(host, port);
      console.log(`  probe        local Chroma at ${host}:${port} — ${reachable ? 'reachable' : 'not reachable'}`);
      if (!reachable) {
        add('WARN', `CHROMA_API_KEY is not set and no Chroma server answered at ${host}:${port}. The app will use the SQLite vector fallback (server/store/sqlite-vector.js) — everything works, but the vector store lives in the local database file. Start Chroma, or set CHROMA_API_KEY to use Chroma Cloud.`);
      }
    }
  }

  // --- unknown variables in .env ------------------------------------------
  if (envFile) {
    const unknown = [...envFile.values.keys()].filter((name) => !KNOWN_NAMES.has(name)).sort();
    if (unknown.length > 0) {
      add('WARN', `${envFile.values.size - unknown.length} of ${envFile.values.size} variables in ${path.basename(envFile.path)} are read by the app. These ${unknown.length} are not read by any module and can be removed: ${unknown.join(', ')}.`);
    }
  }

  // --- required variables: the generic message, only where nothing more
  // specific has already been said about that exact variable ----------------
  const explained = new Set(CONTRACT.map((row) => row.name)
    .filter((name) => report.some((item) => item.level === 'ERROR' && item.message.startsWith(`${name} `))));
  for (const name of missingAlways) {
    if (explained.has(name)) continue;
    add('ERROR', `${name} is required but not set (${byName.get(name).note}). Copy .env.example to .env and fill it in.`);
  }
  for (const name of missingProd) {
    if (explained.has(name)) continue;
    add('ERROR', `${name} is required in production but not set (${byName.get(name).note}). Set it in the Vercel project environment.`);
  }

  // --- verdict -------------------------------------------------------------
  const errors = report.filter((r) => r.level === 'ERROR');
  const warnings = report.filter((r) => r.level === 'WARN');
  const dangers = report.filter((r) => r.level === 'DANGER');

  if (errors.length > 0) {
    console.log(rule);
    for (const item of errors) console.log(`  ERROR   ${item.message}`);
    for (const item of dangers) console.log(`  !!!     ${item.message}`);
    for (const item of warnings) console.log(`  warn    ${item.message}`);
    console.log(rule);
    console.log('RESULT: FAIL — this environment cannot run the app.');
    console.log(`  ${errors.length} problem(s) to fix, ${warnings.length} warning(s).`);
    console.log('  Fix the ERROR lines above (they name the exact variable) and run this script again.');
    console.log('  Every setting belongs in .env locally, or in the Vercel project environment for production.');
    return 1;
  }

  console.log(rule);
  for (const item of dangers) console.log(`  DANGER  ${item.message}`);
  for (const item of warnings) console.log(`  warn    ${item.message}`);
  console.log(rule);
  const optionalSet = present.filter((name) => byName.get(name).need === 'optional').length;
  console.log('RESULT: PASS — this environment can run the app.');
  console.log(`  mode: ${mode} · ${missingAlways.length + missingProd.length} required variable(s) missing · ${present.length} set (${optionalSet} optional) · ${warnings.length} warning(s) · ${dangers.length} danger(s)`);
  if (mode === 'development') {
    console.log('  next: npm start  →  http://localhost:3000/api/health');
  } else {
    console.log('  next: deploy to Vercel, then GET https://<your-deployment>/api/health');
  }
  if (dangers.length > 0) {
    console.log('  NOTE: the DANGER line(s) above are unsafe settings, not broken ones. Read them before exposing this deployment.');
  }
  return 0;
}

process.exitCode = await main();
