import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkSegments } from '../server/services/chunker.js';

test('short segments stay whole and keep their location', () => {
  const chunks = chunkSegments([{ text: 'A short slide.', location: { slide: 3 } }]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'A short slide.');
  assert.deepEqual(chunks[0].location, { slide: 3 });
});

test('long text is split into chunks that stay under the size limit', () => {
  const sentence = 'This is a plain sentence used to build a long page of text. ';
  const segments = [{ text: sentence.repeat(40), location: { page: 7 } }]; // ~2280 chars
  const chunks = chunkSegments(segments, { size: 500, overlap: 100 });
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 620, `chunk too long: ${chunk.text.length}`);
  for (const chunk of chunks) assert.deepEqual(chunk.location, { page: 7 });
});

test('consecutive chunks share overlap context', () => {
  const sentence = 'Recursion means a function calls itself. ';
  const chunks = chunkSegments([{ text: sentence.repeat(20), location: { page: 1 } }], { size: 300, overlap: 80 });
  const tail = chunks[0].text.slice(-60);
  assert.ok(chunks[1].text.includes(tail.trim().split(' ').slice(-3).join(' ')), 'next chunk should repeat the tail');
});

test('empty segments are skipped entirely', () => {
  const chunks = chunkSegments([
    { text: '', location: { page: 1 } },
    { text: '   ', location: { page: 2 } },
    { text: 'Kept.', location: { page: 3 } },
  ]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'Kept.');
});

test('chunk indexes increase monotonically', () => {
  const sentence = 'A sentence for indexing tests. ';
  const chunks = chunkSegments([{ text: sentence.repeat(30), location: { slide: 1 } }], { size: 400, overlap: 50 });
  chunks.forEach((chunk, i) => assert.equal(chunk.chunkIndex, i));
});
