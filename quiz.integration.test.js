const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = 'test-groq-key';
process.env.HF_RETRIEVAL_ENABLED = 'false';

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
      const payload = typeof options.body === 'string' ? JSON.parse(options.body) : {};
      telegramCalls.push({ url: target, payload, body: options.body });
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
    status: 'ok',
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
  assert.equal(groqCalls[0].model, 'openai/gpt-oss-120b');
  assert.equal(groqCalls[0].response_format.json_schema.strict, true);
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
    status: 'ok',
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
    status: 'ok',
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

test('keeps legacy key commands safe and owner-managed', async () => {
  const { telegramCalls, groqCalls } = installFetchMock({});

  await handleUpdate(message('/apikey arbitrary-user-key'));

  assert.equal(groqCalls.length, 0);
  assert.match(telegramMessages(telegramCalls).at(-1), /do not need an API key/i);
});

test('processes full-page vision input in batches of at most five images', async () => {
  const { telegramCalls, groqCalls } = installFetchMock({
    status: 'ok',
    topic: 'Vision',
    question: 'Unused quiz payload',
    choices: ['A', 'B', 'C', 'D'],
    answerIndex: 0,
    explanation: 'Unused.',
  });
  const pages = Array.from({ length: 6 }, (_, index) => ({
    base64: Buffer.from(`page-${index + 1}`).toString('base64'),
    mime: 'image/png',
  }));

  await __test.answerImages(CHAT_ID, pages, 'Solve every question.');

  assert.equal(groqCalls.length, 2);
  assert.equal(groqCalls[0].model, 'qwen/qwen3.6-27b');
  assert.equal(groqCalls[0].messages.at(-1).content.filter((item) => item.type === 'image_url').length, 5);
  assert.equal(groqCalls[1].messages.at(-1).content.filter((item) => item.type === 'image_url').length, 1);
  assert.match(groqCalls[0].messages.at(-1).content[0].text, /page\(s\) 1-5 of 6/i);
  assert.match(groqCalls[1].messages.at(-1).content[0].text, /page\(s\) 6-6 of 6/i);
  assert.match(telegramMessages(telegramCalls).at(-1), /Pages 1-5:/);
  assert.match(telegramMessages(telegramCalls).at(-1), /Pages 6-6:/);
});

test('renders and uploads a validated circuit diagram from a model response', async () => {
  const { telegramCalls } = installFetchMock({});
  const answer = [
    'A half-adder produces a sum and carry output.',
    '```circuit',
    JSON.stringify({
      inputs: ['A', 'B'],
      outputs: ['S', 'Cout'],
      gates: [
        { id: 'sum', type: 'xor', inputs: ['A', 'B'], output: 'S' },
        { id: 'carry', type: 'and', inputs: ['A', 'B'], output: 'Cout' },
      ],
    }),
    '```',
  ].join('\n');

  const rendered = await __test.extractAndSendDiagram(CHAT_ID, answer);

  assert.equal(rendered, true);
  assert.equal(telegramCalls.filter((call) => call.url.includes('/sendPhoto')).length, 1);
});

test('does not upload a diagram when the circuit specification is invalid', async () => {
  const { telegramCalls } = installFetchMock({});
  const answer = '```circuit\n{"inputs":["A"],"outputs":["Y"],"gates":[{"id":"bad","type":"and","inputs":["A","B"],"output":"Y"}]}\n```';

  const rendered = await __test.extractAndSendDiagram(CHAT_ID, answer);

  assert.equal(rendered, null);
  assert.equal(telegramCalls.filter((call) => call.url.includes('/sendPhoto')).length, 0);
});
