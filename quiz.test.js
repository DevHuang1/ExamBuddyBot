const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuiz, parseQuizAnswer } = require('./quiz');

test('normalizes a fenced JSON quiz response', () => {
  const quiz = normalizeQuiz('```json\n{"topic":"Algebra","question":"What is 2 + 2?","choices":["1","2","3","4"],"answerIndex":3,"explanation":"Two plus two equals four."}\n```');
  assert.equal(quiz.topic, 'Algebra');
  assert.equal(quiz.answerIndex, 3);
  assert.deepEqual(quiz.choices, ['1', '2', '3', '4']);
});

test('rejects incomplete generated quizzes', () => {
  assert.throws(
    () => normalizeQuiz({ question: 'Incomplete', choices: ['A'], answerIndex: 0, explanation: '' }),
    /incomplete question/,
  );
});

test('accepts letter and numeric answers but rejects arbitrary text', () => {
  assert.equal(parseQuizAnswer('B'), 1);
  assert.equal(parseQuizAnswer('3.'), 2);
  assert.equal(parseQuizAnswer('answer is B'), null);
  assert.equal(parseQuizAnswer('5'), null);
});
