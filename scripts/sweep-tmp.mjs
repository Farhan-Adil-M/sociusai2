// Sweep leaked test temp directories before a test run.
//
// Why this exists: 19 call sites across tests/ call fs.mkdtempSync() to make a
// throwaway sqlite directory, and none of them ever delete it. Left alone the
// directories accumulate (9,900 of them filled the 3.7G /tmp tmpfs mid-build,
// causing unrelated tests to fail with "database or disk is full").
//
// Safety: only directories older than AGE_MS are removed. A full `npm test`
// takes ~3.3s, so anything created by a test run that is still in flight is
// far too young to match. Concurrency between parallel test runs is safe for
// the same reason.
//
// This is best-effort: it never fails the test run (always exits 0).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIXES = ['socius-']; // every leak site uses a socius-* prefix
const AGE_MS = 10 * 60 * 1000; // 10 minutes — orders of magnitude longer than a test run
const dryRun = process.argv.includes('--dry-run');

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch {
      /* raced with another process — ignore */
    }
  }
  return total;
}

try {
  const now = Date.now();
  let removed = 0;
  let freed = 0;

  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = path.join(os.tmpdir(), name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs < AGE_MS) continue; // too young — might be in flight
      const size = dirSize(full);
      if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
      freed += size;
    } catch {
      /* already gone or unreadable — ignore */
    }
  }

  if (removed > 0) {
    console.log(`[sweep-tmp] ${dryRun ? 'would remove' : 'removed'} ${removed} stale test dir(s), ${human(freed)}`);
  }
} catch (err) {
  console.warn(`[sweep-tmp] skipped: ${err.message}`);
}

process.exit(0);
