// AI organisation: strict validation of model output, the dedupe guard, and
// the guarantee that organisation NEVER blocks or breaks ingestion.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { openDb } from '../server/store/sqlite.js';
import { createApp } from '../server/app.js';
import { fakeVector, makeAi } from './helpers.js';
import { normalizeSuggestion, suggestOrganization } from '../server/services/organizer.js';

const SESSIONS = [
  { id: 'ses_1', title: 'Physics', category: 'subject', status: 'active' },
  { id: 'ses_2', title: 'Research — Black Holes', category: 'research', status: 'active' },
  { id: 'ses_3', title: 'Archived thing', category: 'general', status: 'archived' },
];

const VALID = {
  matchSessionId: 'ses_1', newSession: null, confidence: 'high', reason: 'fits',
};

function post(base, url, body) {
  return fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('normalizeSuggestion accepts and cleans valid output', () => {
  const clean = normalizeSuggestion({ ...VALID }, SESSIONS);
  assert.equal(clean.matchSessionId, 'ses_1');
  assert.equal(clean.confidence, 'high');

  const fresh = normalizeSuggestion({
    matchSessionId: null,
    newSession: { category: 'research', title: 'Quantum Notes', subject: 'quantum', tags: ['Quantum', '', 'MICRO-GRAVITY', 42] },
    confidence: 'low',
    reason: 'no fit',
  }, SESSIONS);
  assert.deepEqual(fresh.newSession, { category: 'research', title: 'Quantum Notes', subject: 'quantum', tags: ['quantum', 'micro-gravity'] });
  assert.equal(fresh.confidence, 'low');
});

test('normalizeSuggestion rejects foreign ids, but only ONE branch, bad enums', () => {
  assert.equal(normalizeSuggestion({ ...VALID, matchSessionId: 'ses_not_in_list' }, SESSIONS), null);
  assert.equal(normalizeSuggestion({ ...VALID, newSession: { category: 'subject', title: 'Both', subject: 'x', tags: [] } }, SESSIONS), null);
  assert.equal(normalizeSuggestion({ ...VALID, matchSessionId: null, newSession: null }, SESSIONS), null);
  assert.equal(normalizeSuggestion({ ...VALID, matchSessionId: null, newSession: { category: 'nonsense', title: 'Valid category', subject: 'x', tags: [] } }, SESSIONS), null);
  assert.equal(normalizeSuggestion({ ...VALID, matchSessionId: null, newSession: { category: 'subject', title: 'x', subject: 'x', tags: [] } }, SESSIONS), null);
  assert.equal(normalizeSuggestion('pure text', SESSIONS), null);
});

test('normalizeSuggestion de-duplicates: proposed new session reuses an existing one', () => {
  const out = normalizeSuggestion({
    matchSessionId: null,
    newSession: { category: 'self-study', title: 'physics', subject: 'waves', tags: [] },
    confidence: 'high',
    reason: 'same title as Physics',
  }, SESSIONS);
  assert.equal(out.matchSessionId, 'ses_1'); // existing "Physics" reused
  assert.equal(out.newSession, null);
});

function buildOrganizingAi(script) {
  let i = 0;
  return makeAi({
    chatCompletion: async (messages) => {
      const value = script[Math.min(i++, script.length - 1)];
      if (value instanceof Error) throw value;
      return typeof value === 'string' && value.startsWith('JSON:') ? value.slice(5) : value;
    },
  });
}

test('AI suggestion flow: suggest → accept → session assignment; model outputs are never trusted as ids', async (t) => {
  const chatScript = [
    'JSON:' + JSON.stringify({ matchSessionId: 'ses_forged_by_model', newSession: null, confidence: 'high', reason: 'x' }), // invalid → retried
    'JSON:' + JSON.stringify({ matchSessionId: null, newSession: { category: 'research', title: 'Black Holes Unit', subject: 'gravitation', tags: ['gravity'] }, confidence: 'high', reason: 'research paper' }),
  ];
  const ai = buildOrganizingAi(chatScript);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-org-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const app = await createApp({ db, ai, vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  // existing session for the dedupe test
  const existing = (await (await post(base, '/api/sessions', { title: 'Black Holes unit' })).json()).session;

  const pptx = (() => { const z = new AdmZip(); z.addFile('[Content_Types].xml', Buffer.from('<Types/>')); z.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld><a:t>Gravitational lensing warps spacetime and bends light.</a:t></p:sld>')); return z.toBuffer(); })();
  const fd = new FormData();
  fd.append('file', new Blob([pptx]), 'black-holes-lecture.pptx');
  const up = await fetch(`${base}/api/sources/upload`, { method: 'POST', body: fd });
  assert.equal(up.status, 201); // upload works BEFORE any AI call
  const sourceId = (await up.json()).source.id;
  const uploadCallCount = ai.calls.length;
  assert.ok(uploadCallCount < 0 || true); // can't not-call — but the upload itself made no AI call:
  assert.equal(uploadCallCount, 0);

  // suggestion runs separately — and the dedupe guard replaces the proposed
  // "Black Holes Unit" with the existing "Black Holes unit" session
  const sugg = await post(base, `/api/sources/${sourceId}/suggest-organization`, {});
  assert.equal(sugg.status, 200);
  const suggBody = await sugg.json();
  assert.equal(suggBody.applicable, true);
  assert.equal(suggBody.suggestion.newSession, null);
  assert.equal(suggBody.suggestion.matchSessionId, existing.id);
  assert.equal(suggBody.suggestion.confidence, 'high');

  // accept assigns to the reused session — not a fresh duplicate
  const acc = await post(base, `/api/sources/${sourceId}/accept-suggestion`, {});
  assert.equal(acc.status, 200);
  const accBody = await acc.json();
  assert.equal(accBody.session.id, existing.id);
  const src = (await (await fetch(`${base}/api/sources`)).json()).sources[0];
  assert.equal(src.sessionId, existing.id);
  assert.equal(src.orgSource, 'ai');

  // manual move overrides: later suggestions flag as not applicable
  const text = 'X'.repeat(80);
  const otherSource = (await (await post(base, '/api/sources/webpage', { url: 'https://x.example/selfstudy', text })).json()).source;
  await fetch(`${base}/api/sources/${otherSource.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: existing.id }) });
  const sugg2 = await post(base, `/api/sources/${otherSource.id}/suggest-organization`, {});
  assert.equal((await sugg2.json()).applicable, false); // shown, never auto-applied

  // the source the user moved by hand has NOT been silently reassigned
  const srcList = await (await fetch(`${base}/api/sources`)).json();
  const stillThere = srcList.sources.find((s) => s.id === otherSource.id);
  assert.equal(stillThere.sessionId, existing.id);
});

test('upload works fine even when the AI service is completely down', async (t) => {
  const ai = makeAi({ chatCompletion: async () => { throw new Error('provider down'); } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-org2-'));
  const db = await openDb(path.join(dir, 'app.db'));
  const app = await createApp({ db, ai, vector: fakeVector() });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://localhost:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));

  const webpageRes = await post(base, '/api/sources/webpage', { url: 'https://x.example/lesson', text: 'Y'.repeat(90) });
  assert.equal(webpageRes.status, 201);
  assert.equal(ai.calls.length, 0); // ingestion never needed the model

  const sourceId = (await webpageRes.json()).source.id;
  const sugg = await post(base, `/api/sources/${sourceId}/suggest-organization`, {});
  assert.equal(sugg.status, 502); // honest failure of the SUGGESTION, not the source
  assert.equal((await sugg.json()).error.code, 'NIM_ERROR');

  const sources = (await (await fetch(`${base}/api/sources`)).json());
  assert.equal(sources.sources.length, 1);
  assert.equal(sources.sources[0].sessionId, null); // sits in Unsorted, ready for manual organisation
  assert.equal(sources.unsortedSourceCount, 1);
});

test('honest 502 without touching ingestion when the model returns empty or unusable output twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socius-org3-'));
  const db = await openDb(path.join(dir, 'app.db'));
  db.prepare("INSERT INTO sources (id, type, title, created_at) VALUES ('src_x', 'webpage', 'Unorganised note', '2026-10-13T00:00:00.000Z')").run();

  // empty content twice (what the audit observed live)
  await assert.rejects(
    () => suggestOrganization(db, { sourceId: 'src_x' }, { chat: async () => '' }),
    (err) => err.code === 'NIM_ERROR' && err.status === 502,
  );
  // unusable text twice
  await assert.rejects(
    () => suggestOrganization(db, { sourceId: 'src_x' }, { chat: async () => 'no json here at all, sorry' }),
    (err) => err.code === 'NIM_ERROR',
  );

  // the source is still ingested and still Unsorted —organisation failure must not break the library
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get('src_x');
  assert.equal(row.session_id, null);
  assert.equal(row.title, 'Unorganised note');
});
