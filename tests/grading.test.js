import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeAnswers, normalizeQuestion, parseJsonLoose } from '../server/services/quizService.js';

const questions = [
  {
    idx: 0, text: 'Q1?', correct_choice_id: 'b', explanation: 'Because.', citations_json: '[]',
    choices_json: JSON.stringify([{ id: 'a', text: 'wrong' }, { id: 'b', text: 'right' }]),
  },
  {
    idx: 1, text: 'Q2?', correct_choice_id: 'a', explanation: 'Yes.', citations_json: '[]',
    choices_json: JSON.stringify([{ id: 'a', text: 'right' }, { id: 'b', text: 'wrong' }]),
  },
];

test('deterministic grading: exact string comparison, no AI', () => {
  const { correct, total, perQuestion } = gradeAnswers(questions, [
    { index: 0, choiceId: 'b' },
    { index: 1, choiceId: 'b' },
  ]);
  assert.equal(correct, 1);
  assert.equal(total, 2);
  assert.equal(perQuestion[0].correct, true);
  assert.equal(perQuestion[1].correct, false);
  // The key is revealed only in this post-submission response:
  assert.equal(perQuestion[0].correctChoiceId, 'b');
  assert.equal(perQuestion[0].yourChoiceId, 'b');
});

test('unanswered (null) counts as incorrect', () => {
  const { correct } = gradeAnswers(questions, [
    { index: 0, choiceId: null },
    { index: 1, choiceId: 'a' },
  ]);
  assert.equal(correct, 1);
});

test('out-of-range, duplicate, and invalid choice ids are rejected', () => {
  assert.throws(() => gradeAnswers(questions, [{ index: 5, choiceId: 'a' }]), { code: 'VALIDATION_ERROR' });
  assert.throws(() => gradeAnswers(questions, [
    { index: 0, choiceId: 'a' }, { index: 0, choiceId: 'b' },
  ]), { code: 'VALIDATION_ERROR' });
  assert.throws(() => gradeAnswers(questions, [{ index: 0, choiceId: 'z' }]), { code: 'VALIDATION_ERROR' });
  assert.throws(() => gradeAnswers(questions, []), { code: 'VALIDATION_ERROR' });
});

test('normalizeQuestion accepts a valid model response', () => {
  const q = normalizeQuestion({
    question: 'What does recursion mean?',
    choices: ['A function calling itself', 'A loop', 'A variable', 'A file'],
    answer: 'A function calling itself',
    explanation: 'That is the definition.',
    cite: [1, 99, 'x'],
  }, { topic: 'recursion' });
  assert.equal(q.correctChoiceId, 'a');
  assert.equal(q.choices.length, 4);
  assert.deepEqual(q.cite, [1, 99]); // non-integers dropped, range checked at citation time
});

test('normalizeQuestion rejects wrong counts, duplicates, and unknown answers', () => {
  const base = { question: 'Long enough question?', choices: ['a', 'b', 'c', 'd'], answer: 'a' };
  assert.equal(normalizeQuestion({ ...base, choices: ['a', 'b', 'c'] }, { topic: 't' }), null);
  assert.equal(normalizeQuestion({ ...base, choices: ['a', 'a', 'c', 'd'] }, { topic: 't' }), null);
  assert.equal(normalizeQuestion({ ...base, answer: 'not-a-choice' }, { topic: 't' }), null);
  assert.equal(normalizeQuestion({ ...base, question: 'short' }, { topic: 't' }), null);
});

test('parseJsonLoose survives fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a": 2} hope it helps'), { a: 2 });
  assert.equal(parseJsonLoose('no json here'), null);
  assert.equal(parseJsonLoose('{broken'), null);
});
