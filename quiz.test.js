const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFlashcards, normalizeQuiz, parseQuizAnswer } = require('./quiz');

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

test('normalizes five complete source-cited flashcards', () => {
  const flashcards = normalizeFlashcards({
    topic: 'Algebra',
    cards: Array.from({ length: 5 }, (_, index) => ({
      front: `Card ${index + 1} question`,
      back: `Card ${index + 1} answer`,
      source: 'PDF 1, page 1',
    })),
  });

  assert.equal(flashcards.topic, 'Algebra');
  assert.equal(flashcards.cards.length, 5);
  assert.equal(flashcards.cards[0].source, 'PDF 1, page 1');
});

test('rejects flashcards that are incomplete or missing source citations', () => {
  assert.throws(
    () => normalizeFlashcards({
      topic: 'Algebra',
      cards: Array.from({ length: 5 }, (_, index) => ({
        front: `Card ${index + 1} question`,
        back: `Card ${index + 1} answer`,
        source: index === 0 ? '' : 'PDF 1, page 1',
      })),
    }),
    /incomplete or uncited cards/i,
  );
});

test('accepts letter and numeric answers but rejects arbitrary text', () => {
  assert.equal(parseQuizAnswer('B'), 1);
  assert.equal(parseQuizAnswer('3.'), 2);
  assert.equal(parseQuizAnswer('answer is B'), null);
  assert.equal(parseQuizAnswer('5'), null);
});
