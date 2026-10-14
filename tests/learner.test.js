import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAttempt, chooseDifficulty, difficultyFor, needsRevision, suggestNext,
} from '../server/services/learner.js';

test('difficulty thresholds follow the documented rules', () => {
  assert.equal(difficultyFor(0.0), 'easy');
  assert.equal(difficultyFor(0.49), 'easy');
  assert.equal(difficultyFor(0.5), 'medium');
  assert.equal(difficultyFor(0.79), 'medium');
  assert.equal(difficultyFor(0.8), 'hard');
  assert.equal(difficultyFor(1.0), 'hard');
});

test('needs revision only after at least 3 attempts and below 60%', () => {
  assert.equal(needsRevision({ correct: 0, total: 2 }), false); // too few attempts
  assert.equal(needsRevision({ correct: 1, total: 3 }), true); // 33% with 3 attempts
  assert.equal(needsRevision({ correct: 2, total: 3 }), false); // 67% is above the 60% line
});

test('needsRevision boundary at exactly 60%', () => {
  assert.equal(needsRevision({ correct: 3, total: 5 }), false); // 60% is not below 60%
  assert.equal(needsRevision({ correct: 2, total: 5 }), true); // 40%
});

test('applyAttempt computes mastery, delta and next difficulty', () => {
  const update = applyAttempt('Photosynthesis', { correct: 1, total: 2 }, { correct: 2, total: 3 });
  assert.equal(update.topic, 'photosynthesis'); // normalized key
  assert.equal(update.correct, 3);
  assert.equal(update.total, 5);
  assert.equal(update.before, 0.5);
  assert.equal(update.mastery, 0.6);
  assert.equal(update.difficulty, 'medium');
  assert.ok(Math.abs(update.delta - 0.1) < 1e-9);
});

test('first attempt has null before/delta', () => {
  const update = applyAttempt('Recursion', null, { correct: 1, total: 2 });
  assert.equal(update.before, null);
  assert.equal(update.delta, null);
  assert.equal(update.mastery, 0.5);
});

test('chooseDifficulty: new topic starts medium, then follows mastery', () => {
  assert.equal(chooseDifficulty(null), 'medium');
  assert.equal(chooseDifficulty({ correct: 0, total: 0 }), 'medium');
  assert.equal(chooseDifficulty({ correct: 1, total: 4 }), 'easy');
  assert.equal(chooseDifficulty({ correct: 4, total: 4 }), 'hard');
});

test('suggestNext prefers the worst topic that needs revision', () => {
  const topics = [
    { topic: 'photosynthesis', correct: 9, total: 10 },
    { topic: 'recursion', correct: 1, total: 5 },
    { topic: 'loops', correct: 2, total: 4 },
  ];
  assert.deepEqual(suggestNext(topics), { topic: 'recursion', difficulty: 'easy' });
});

test('suggestNext falls back to least-practised topic when nothing is flagged', () => {
  const topics = [
    { topic: 'photosynthesis', correct: 9, total: 10 },
    { topic: 'loops', correct: 5, total: 6 },
  ];
  assert.deepEqual(suggestNext(topics), { topic: 'loops', difficulty: 'hard' });
  assert.equal(suggestNext([]), null);
});
