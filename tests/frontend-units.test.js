// tests/frontend-units.test.js — the pure, DOM-free logic inside the frontend
// components, run under plain `node:test` with no browser and no DOM shim.
//
// How this works without a browser:
//   - All three component modules are import-safe in Node: they only touch
//     `document`/`window` INSIDE functions, never at module scope (ui.js even
//     guards `ensureSprite()` with `typeof document === 'undefined'`).
//   - `api.js` is the one network door, so this file installs a route-table
//     mock on `globalThis.fetch` (auth boot asks /api/health once; component
//     calls hit the registered test routes). `authReady()` never rejects, so
//     the pipeline runs end-to-end in prototype mode.
//   - scope-select's `populateScopeSelect(select, note)` only ASSIGNS
//     `select.innerHTML` / `note.textContent` — plain-object fakes suffice.
//   - file-viewer's pagination (`paginate()`) is unexported, so it is tested
//     honestly through the public `mountFileViewer()` with a 2-property fake
//     host (`{ innerHTML, addEventListener() {} }`) and the mocked fetch; the
//     resulting HTML string is parsed for the section list/labels, which is
//     where the pagination maths is visible. A one-line `window.location.search`
//     stand-in is needed because `mountFileViewer()` reads the URL unconditionally.
//
// NOT covered here (and why):
//   - session-form's title/tag VALIDATION lives inside the <form> submit
//     handler bound to real elements (`titleInput.value`, `.focus()`); testing
//     it would require a real DOM, which this suite deliberately does not fake.
//     Only its pure exports (CATEGORIES, categoryLabel) are tested.
//   - scope-select/file-viewer DOM wiring (event listeners, focus moves,
//     live-region lifecycles) needs a real browser; see docs/HANDOFF.md for
//     the browser-verification recipes other passes left behind.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, categoryLabel } from '../frontend/js/components/session-form.js';
import { populateScopeSelect } from '../frontend/js/components/scope-select.js';
import { mountFileViewer, viewerUrl } from '../frontend/js/components/file-viewer.js';

/* ------------------------------------------------------- fetch route table -- */

const fetchCalls = [];
const routes = new Map();
const HEALTH_BODY = { ok: true, checks: { auth: { mode: 'prototype' } } };

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Register a responder for an exact request path. The responder returns a
 *  Response or throws (a throw mimics a network failure for api.js). */
function route(path, responder) {
  routes.set(path, responder);
}

globalThis.fetch = async (path) => {
  const key = String(path);
  sink.push(key);
  if (key === '/api/health') return jsonResponse(HEALTH_BODY);
  const responder = routes.get(key);
  if (!responder) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'no test route' } }, 404);
  return await responder();
};

/** Requests recorded into the shared array. `sink` is redirected per test by
 *  ownRecording(), so a test that asserts on the exact request list cannot be
 *  corrupted by another test's resetRoutes() clearing the shared array out
 *  from under it (fetches are issued synchronously inside the component, so
 *  every request a test makes lands in the sink that was current at call time).
 */
let sink = fetchCalls;

function ownRecording() {
  sink = [];
  return sink;
}

function resetRoutes() {
  routes.clear();
  fetchCalls.length = 0;
  sink = fetchCalls;
}

// `mountFileViewer()` reads `window.location.search` unconditionally, so the
// smallest possible stand-in is defined (no document, no elements, no storage).
globalThis.window = { location: { search: '' } };

/* ============================================ session-form.js (pure parts) == */

test('session-form: CATEGORIES is exactly the contract enum, in order, without duplicates', () => {
  assert.deepEqual(CATEGORIES.map((item) => item.value), [
    'subject', 'research', 'self-study', 'exam-prep', 'general',
  ]);
  assert.equal(new Set(CATEGORIES.map((item) => item.value)).size, CATEGORIES.length);
  for (const item of CATEGORIES) {
    assert.equal(typeof item.value, 'string');
    assert.ok(item.value.length > 0, 'every category needs a non-empty value');
    assert.ok(typeof item.label === 'string' && item.label.length > 0,
      `category ${item.value} needs a human label`);
  }
});

test('session-form: categoryLabel maps every enum value to its human label', () => {
  assert.equal(categoryLabel('subject'), 'Subject');
  assert.equal(categoryLabel('research'), 'Research');
  assert.equal(categoryLabel('self-study'), 'Self-study');
  assert.equal(categoryLabel('exam-prep'), 'Exam prep');
  assert.equal(categoryLabel('general'), 'General');
  // and the loop form, so a future enum entry cannot silently lack a label:
  for (const item of CATEGORIES) assert.equal(categoryLabel(item.value), item.label);
});

test('session-form: categoryLabel falls back to the raw value for unknown input', () => {
  assert.equal(categoryLabel('History'), 'History');
  assert.equal(categoryLabel('SELF-STUDY'), 'SELF-STUDY'); // case must not "fix" silently
});

test('session-form: categoryLabel turns missing values into an empty string', () => {
  assert.equal(categoryLabel(''), '');
  assert.equal(categoryLabel(null), '');
  assert.equal(categoryLabel(undefined), '');
});

/* ==================================================== scope-select.js ======= */

function fakeSelect() {
  return { innerHTML: '' };
}
function fakeNote() {
  return { textContent: '' };
}

test('scope-select: a missing select is a no-op that never fetches', async () => {
  resetRoutes();
  const calls = ownRecording();
  assert.deepEqual(await populateScopeSelect(null), []);
  assert.deepEqual(await populateScopeSelect(undefined, fakeNote()), []);
  assert.deepEqual(calls, []);
});

test('scope-select: "All material" stays first, then one escaped option per source, in order', async () => {
  resetRoutes();
  const sources = [
    { id: 'src_1', title: 'Cells' },
    { id: 'src "q" & <t>', title: 'A "quoted" & <tagged> title' },
    { id: 'src_3' }, // no title at all
    { id: 'src_4', title: '' }, // empty title
  ];
  route('/api/sources', () => jsonResponse({ sources }));

  const calls = ownRecording();
  const select = fakeSelect();
  const loaded = await populateScopeSelect(select);

  assert.deepEqual(loaded, sources); // resolves with the sources that were loaded
  assert.deepEqual(
    [...select.innerHTML.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]),
    [
      ['', 'All material'],
      ['src_1', 'Cells'],
      ['src &quot;q&quot; &amp; &lt;t&gt;', 'A &quot;quoted&quot; &amp; &lt;tagged&gt; title'],
      ['src_3', 'Untitled source'],
      ['src_4', 'Untitled source'],
    ],
  );
  // exactly one plain GET, no query string when no sessionId was given:
  assert.deepEqual(calls, ['/api/health', '/api/sources']);
});

test('scope-select: one source reads "1 source available" (singular/plural boundary)', async () => {
  resetRoutes();
  route('/api/sources', () => jsonResponse({ sources: [{ id: 's1', title: 'Only one' }] }));
  const note = fakeNote();
  const loaded = await populateScopeSelect(fakeSelect(), note);
  assert.equal(loaded.length, 1);
  assert.equal(note.textContent, '1 source available');
});

test('scope-select: zero sources says there are none yet, keeping the safe default option', async () => {
  resetRoutes();
  route('/api/sources', () => jsonResponse({ sources: [] }));
  const select = fakeSelect();
  const note = fakeNote();
  assert.deepEqual(await populateScopeSelect(select, note), []);
  assert.equal(select.innerHTML, '<option value="">All material</option>');
  assert.equal(note.textContent, 'No sources yet — add material in My Materials first.');
});

test('scope-select: a sessionId scopes the request, fully encoded into the query string', async () => {
  resetRoutes();
  const sources = [{ id: 's1', title: 'Scoped' }];
  route('/api/sources?sessionId=a%20b%26c', () => jsonResponse({ sources }));

  const calls = ownRecording();
  const loaded = await populateScopeSelect(fakeSelect(), fakeNote(), { sessionId: 'a b&c' });

  assert.deepEqual(loaded, sources);
  // The raw '&' must be encoded, or it would smuggle a second query parameter.
  //
  // Only the sources request is asserted here, not the /api/health boot call:
  // api.js resolves auth once per process and caches the promise, so the boot
  // request belongs to whichever test happens to trigger it first (asserted in
  // full by the "All material stays first" test above). What this test owns is
  // the path it asked for — and if the sessionId were not encoded, the request
  // would miss this route and answer 404, leaving `loaded` empty.
  assert.deepEqual(calls, ['/api/sources?sessionId=a%20b%26c']);
});

test('scope-select: a failed load keeps the safe "All material" default', async () => {
  resetRoutes();
  route('/api/sources', () => { throw new Error('network down'); });
  const select = fakeSelect();
  const note = fakeNote();
  assert.deepEqual(await populateScopeSelect(select, note), []);
  assert.equal(select.innerHTML, '<option value="">All material</option>');
  assert.equal(note.textContent, 'Source list unavailable — questions will search all your material.');
});

test('scope-select: a 200 without a usable sources array is treated as an empty list', async () => {
  resetRoutes();
  route('/api/sources', () => jsonResponse({ ok: true })); // no `sources` key
  const select = fakeSelect();
  const note = fakeNote();
  assert.deepEqual(await populateScopeSelect(select, note), []);
  assert.equal(select.innerHTML, '<option value="">All material</option>');
  assert.equal(note.textContent, 'No sources yet — add material in My Materials first.');
});

test('scope-select: a note element is optional', async () => {
  resetRoutes();
  const sources = [{ id: 's1', title: 'One' }];
  route('/api/sources', () => jsonResponse({ sources }));
  const select = fakeSelect();
  assert.deepEqual(await populateScopeSelect(select), sources);
  assert.ok(select.innerHTML.includes('<option value="s1">One</option>'));
});

/* ===================================================== file-viewer.js ======= */

/** Mount the viewer for one mocked /api/viewer payload; resolve once the host
 *  has rendered the state identified by `marker` (the loading panel is painted
 *  synchronously, so an empty marker check would resolve too early). */
async function mountDocument(id, document, marker = 'id="fv-jump"') {
  route(`/api/viewer/${id}`, () => jsonResponse({ document }));
  const host = { innerHTML: '', addEventListener() {} };
  const liveRegion = { textContent: '' };
  mountFileViewer({ host, sourceId: id, liveRegion });
  const deadline = Date.now() + 2000;
  while (!host.innerHTML.includes(marker)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(marker)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { host, liveRegion };
}

const viewerDoc = (segments, extra = {}) => ({
  sourceId: 'src', type: 'docx', title: 'T', viewable: true, segments, ...extra,
});

const paraSeg = (paragraph, len, char = 'a') => ({ location: { paragraph }, text: char.repeat(len) });

/** The jump <select>'s option labels — the full section list, in order. */
function jumpLabels(html) {
  const jump = /id="fv-jump"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  if (!jump) return null;
  return [...jump[1].matchAll(/<option value="\d+"[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
}
const positionTextOf = (html) => /data-fv-position>([^<]*)</.exec(html)?.[1] ?? '';
const renderedSections = (html) => (html.match(/<article class="fv-section"/g) || []).length;

test('file-viewer: viewerUrl puts the (encoded) source id on the viewer link', () => {
  assert.equal(viewerUrl('src_1'), 'viewer.html?source=src_1');
  assert.equal(viewerUrl('a b/c&d'), 'viewer.html?source=a%20b%2Fc%26d');
  assert.equal(viewerUrl(null), 'viewer.html?source=');
  assert.equal(viewerUrl(undefined), 'viewer.html?source=');
  assert.equal(viewerUrl(42), 'viewer.html?source=42'); // non-strings are coerced
});

test('file-viewer: PDF pages stay whole — one section per page, even a page over the char cap', async () => {
  resetRoutes();
  const { host, liveRegion } = await mountDocument('pdf', viewerDoc([
    { index: 0, location: { page: 1 }, text: 'p'.repeat(7000) }, // over MAX_PAGE_CHARS, still whole
    { index: 1, location: { page: 2 }, text: 'short' },
    { index: 2, location: { page: 3 }, text: 'x' },
  ], { type: 'pdf' }));

  assert.deepEqual(jumpLabels(host.innerHTML), ['Page 1', 'Page 2', 'Page 3']);
  assert.equal(positionTextOf(host.innerHTML), 'Section 1 of 3');
  assert.equal(liveRegion.textContent, 'T opened \u2014 3 reading sections.');
  // "one section at a time" renders exactly the current section:
  assert.equal(renderedSections(host.innerHTML), 1);
  assert.ok(host.innerHTML.includes('>Page 1</h2>'), 'the current section shows its own label');
});

test('file-viewer: page 0 is a real page (nullish check, not truthiness)', async () => {
  resetRoutes();
  const { host } = await mountDocument('pdf0', viewerDoc(
    [{ index: 0, location: { page: 0 }, text: 'first' }],
    { type: 'pdf' },
  ));
  assert.deepEqual(jumpLabels(host.innerHTML), ['Page 0']);
});

test('file-viewer: slides are labelled as slides', async () => {
  resetRoutes();
  const { host } = await mountDocument('pptx', viewerDoc([
    { index: 0, location: { slide: 1 }, text: 'one' },
    { index: 1, location: { slide: 2 }, text: 'two' },
  ], { type: 'pptx' }));
  assert.deepEqual(jumpLabels(host.innerHTML), ['Slide 1', 'Slide 2']);
});

test('file-viewer: every segment carrying page OR slide keeps the structured path', async () => {
  resetRoutes();
  const { host } = await mountDocument('mix2', viewerDoc([
    { index: 0, location: { page: 1 }, text: 'a' },
    { index: 1, location: { slide: 2 }, text: 'b' },
  ]));
  assert.deepEqual(jumpLabels(host.innerHTML), ['Page 1', 'Slide 2']);
});

test('file-viewer: one segment without a page/slide falls back to grouped sections', async () => {
  resetRoutes();
  const { host } = await mountDocument('mixed', viewerDoc([
    { index: 0, location: { page: 1 }, text: 'a'.repeat(950) },
    { index: 1, location: {}, text: 'b'.repeat(950) }, // no page or slide → grouped path
  ]));
  // Grouped, and with no paragraph numbers the labels fall back to "Section N":
  assert.deepEqual(jumpLabels(host.innerHTML), ['Section 1', 'Section 2']);
});

test('file-viewer: grouping closes a section exactly at the 900-char floor', async () => {
  resetRoutes();
  const { host } = await mountDocument('floor', viewerDoc([
    paraSeg(1, 900), // exactly MIN_PAGE_CHARS…
    paraSeg(2, 10, 'b'), // …so the NEXT paragraph starts a new section
  ]));
  assert.deepEqual(jumpLabels(host.innerHTML), ['Paragraph 1', 'Paragraph 2']);
});

test('file-viewer: one char under the floor, the paragraphs stay together', async () => {
  resetRoutes();
  const { host } = await mountDocument('under', viewerDoc([
    paraSeg(1, 899),
    paraSeg(2, 10, 'b'),
  ]));
  assert.deepEqual(jumpLabels(host.innerHTML), ['Paragraphs 1\u20132']);
});

test('file-viewer: a section may hold exactly 6000 chars; 6001 splits', async () => {
  resetRoutes();
  const exact = await mountDocument('cap6000', viewerDoc([
    paraSeg(1, 800), // under the floor, so the floor cannot close it first…
    paraSeg(2, 5200, 'b'), // …and 800 + 5200 = 6000 exactly → no overflow split
  ]));
  assert.deepEqual(jumpLabels(exact.host.innerHTML), ['Paragraphs 1\u20132']);

  const over = await mountDocument('cap6001', viewerDoc([
    paraSeg(1, 800),
    paraSeg(2, 5300, 'b'), // 800 + 5300 = 6100 > MAX_PAGE_CHARS → new section
  ]));
  assert.deepEqual(jumpLabels(over.host.innerHTML), ['Paragraph 1', 'Paragraph 2']);
});

test('file-viewer: grouped labels are singular for one paragraph and ranged otherwise', async () => {
  resetRoutes();
  const single = await mountDocument('onepara', viewerDoc([paraSeg(1, 50)]));
  assert.deepEqual(jumpLabels(single.host.innerHTML), ['Paragraph 1']);

  // 40 paragraphs of 50 chars = 2000 chars: sections close at the 900-char
  // floor (18 + 18 + 4), each labelled with its own paragraph range.
  const many = await mountDocument('manypara', viewerDoc(
    Array.from({ length: 40 }, (_, i) => paraSeg(i + 1, 50)),
  ));
  assert.deepEqual(jumpLabels(many.host.innerHTML), [
    'Paragraphs 1\u201318', 'Paragraphs 19\u201336', 'Paragraphs 37\u201340',
  ]);
});

test('file-viewer: segments with no location at all fall back to "Section N"', async () => {
  resetRoutes();
  const { host } = await mountDocument('noloc', viewerDoc([{ index: 0, text: 'a'.repeat(2000) }]));
  assert.deepEqual(jumpLabels(host.innerHTML), ['Section 1']);
});

// FILED DEFECT — see docs/HANDOFF.md
// Current behaviour: the 60-segment cap (MAX_PAGE_SEGMENTS) never forces a
// page break, because `enoughOnThisPage` requires the 900-char floor AND
// segments < 60 — the count term can only PREVENT a close, never cause one.
// 65 tiny paragraphs therefore render as ONE section. If the defect is fixed
// (|| instead of &&), this test's expectation must flip.
test('file-viewer: FILED DEFECT — the 60-segment cap never forces a page break', async () => {
  resetRoutes();
  const { host } = await mountDocument('tinyparas', viewerDoc(
    Array.from({ length: 65 }, (_, i) => paraSeg(i + 1, 10)), // 650 chars total, under the floor
  ));
  assert.deepEqual(jumpLabels(host.innerHTML), ['Paragraphs 1\u201365']);
});

test('file-viewer: viewable:false renders the honest "nothing to read" state', async () => {
  resetRoutes();
  const { host, liveRegion } = await mountDocument('notviewable', {
    sourceId: 'src', type: 'docx', title: 'T', viewable: false,
    segments: [{ index: 0, location: { paragraph: 1 }, text: 'hidden text' }],
  }, 'empty-state');
  assert.ok(host.innerHTML.includes('Nothing to read here yet'));
  assert.ok(host.innerHTML.includes('Material: T (Word document).'));
  assert.equal(liveRegion.textContent, '', 'the not-viewable state announces nothing');
});

test('file-viewer: a document with zero segments renders the same empty state', async () => {
  resetRoutes();
  const { host } = await mountDocument('emptydoc', {
    sourceId: 'src', type: 'pdf', title: 'Empty', viewable: true, segments: [],
  }, 'empty-state');
  assert.ok(host.innerHTML.includes('Nothing to read here yet'));
  assert.ok(host.innerHTML.includes('Material: Empty (PDF).'));
});
