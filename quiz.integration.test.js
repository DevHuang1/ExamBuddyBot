const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = 'test-groq-key';

const { handleUpdate, __test } = require('./server');

const CHAT_ID = 4242;
const originalFetch = global.fetch;

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function installFetchMock(quizPayload) {
  const telegramCalls = [];
  const groqCalls = [];

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('api.groq.com/openai/v1/chat/completions')) {
      groqCalls.push(JSON.parse(options.body));
      return response({
        choices: [{ message: { content: JSON.stringify(quizPayload) } }],
      });
    }

    if (target.includes('api.telegram.org')) {
      const payload = options.body ? JSON.parse(options.body) : {};
      telegramCalls.push({ url: target, payload });
      return response({ ok: true, result: {} });
    }

    throw new Error(`Unexpected request: ${target}`);
  };

  return { telegramCalls, groqCalls };
}

function message(text) {
  return { message: { chat: { id: CHAT_ID }, text } };
}

function telegramMessages(calls) {
  return calls
    .filter((call) => call.url.includes('/sendMessage'))
    .map((call) => call.payload.text);
}

function seedSource() {
  __test.sources.set(CHAT_ID, {
    pdfs: [{
      name: 'Algebra lecture.pdf',
      type: 'pdf',
      pages: 1,
      text: '[Page 1] Algebra uses variables to represent unknown values. A linear equation has degree one.',
    }],
    images: [],
  });
}

test.afterEach(() => {
  __test.resetTestState();
  global.fetch = originalFetch;
});

test('responds safely to /quiz when the chat has no uploaded source', async () => {
  const { telegramCalls, groqCalls } = installFetchMock({});

  await handleUpdate(message('/quiz algebra'));

  assert.equal(groqCalls.length, 0);
  assert.equal(telegramMessages(telegramCalls).length, 1);
  assert.match(telegramMessages(telegramCalls)[0], /first upload a PDF or PPTX source/i);
});

test('runs the /quiz command end to end and accepts a correct Telegram answer', async () => {
  const quizPayload = {
    topic: 'Algebra',
    question: 'Which degree does a linear equation have?',
    choices: ['Zero', 'One', 'Two', 'Three'],
    answerIndex: 1,
    explanation: 'A linear equation has degree one.',
  };
  const { telegramCalls, groqCalls } = installFetchMock(quizPayload);
  seedSource();

  await handleUpdate(message('/quiz linear equations'));

  assert.equal(groqCalls.length, 1);
  assert.match(groqCalls[0].messages.at(-1).content[0].text, /Requested focus: linear equations/i);
  assert.match(groqCalls[0].messages.at(-1).content[0].text, /Algebra lecture\.pdf/);
  const quizMessages = telegramMessages(telegramCalls);
  assert.equal(quizMessages.length, 1);
  assert.match(quizMessages[0], /Practice quiz: Algebra/);
  assert.match(quizMessages[0], /<b>B\.<\/b> One/);
  assert.equal(__test.activeQuizzes.get(CHAT_ID).answerIndex, 1);

  await handleUpdate(message('B'));

  const feedback = telegramMessages(telegramCalls).at(-1);
  assert.match(feedback, /Correct/);
  assert.match(feedback, /A linear equation has degree one/);
  assert.equal(__test.activeQuizzes.has(CHAT_ID), false);
});

test('returns the correct answer and explanation after an incorrect quiz response', async () => {
  const quizPayload = {
    topic: 'Algebra',
    question: 'Which degree does a linear equation have?',
    choices: ['Zero', 'One', 'Two', 'Three'],
    answerIndex: 1,
    explanation: 'A linear equation has degree one.',
  };
  const { telegramCalls } = installFetchMock(quizPayload);
  seedSource();

  await handleUpdate(message('/quiz'));
  await handleUpdate(message('D'));

  const feedback = telegramMessages(telegramCalls).at(-1);
  assert.match(feedback, /Not quite/);
  assert.match(feedback, /correct answer is <b>B\. One<\/b>/);
  assert.match(feedback, /A linear equation has degree one/);
});

test('surfaces a safe Telegram error when the quiz model returns malformed content', async () => {
  const { telegramCalls } = installFetchMock({
    topic: 'Algebra',
    question: 'Incomplete response',
    choices: ['Only one option'],
    answerIndex: 0,
    explanation: '',
  });
  seedSource();

  await handleUpdate(message('/quiz algebra'));

  const feedback = telegramMessages(telegramCalls).at(-1);
  assert.match(feedback, /Quiz creation failed safely/);
  assert.equal(__test.activeQuizzes.has(CHAT_ID), false);
});
