const test = require('node:test');
const assert = require('node:assert/strict');
const { SemanticReranker, cosineSimilarity, fuzzySemanticScore, termSimilarity } = require('./semantic-reranker');

test('computes cosine similarity for aligned vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('recognizes close spellings in local term matching', () => {
  assert.ok(termSimilarity('liniar', 'linear') > 0.8);
  assert.ok(fuzzySemanticScore('degree of a liniar equation', 'A linear equation has degree one.') > 0.8);
});

test('reranks source chunks with Hugging Face feature-extraction embeddings', async () => {
  let request;
  const reranker = new SemanticReranker({
    token: 'test-token',
    clientFactory: async () => ({
      featureExtraction: async (input) => {
        request = input;
        return [
          [1, 0],
          [0.1, 0.9],
          [0.95, 0.05],
        ];
      },
    }),
  });
  const candidates = [
    { chunk: 'A history passage', score: 8 },
    { chunk: 'An algebra passage', score: 2 },
  ];

  const ranked = await reranker.rank('algebra question', candidates);

  assert.equal(request.model, 'thenlper/gte-large');
  assert.equal(request.provider, 'hf-inference');
  assert.equal(request.normalize, true);
  assert.equal(ranked[0].chunk, 'An algebra passage');
  assert.ok(ranked[0].semanticScore > ranked[1].semanticScore);
});

test('uses local typo-tolerant source matching when no Hugging Face token is configured', async () => {
  const reranker = new SemanticReranker();
  const candidates = [
    { chunk: 'The French Revolution began in 1789.', score: 50 },
    { chunk: 'A linear equation has degree one.', score: 1 },
  ];

  const ranked = await reranker.rank('What is the degree of a liniar equation?', candidates);

  assert.equal(ranked[0].chunk, 'A linear equation has degree one.');
  assert.ok(ranked[0].semanticScore > ranked[1].semanticScore);
});

test('uses local matching after a remote embedding failure and stops retrying the failed provider', async () => {
  let calls = 0;
  const reranker = new SemanticReranker({
    token: 'test-token',
    clientFactory: async () => ({
      featureExtraction: async () => {
        calls++;
        throw new Error('provider unavailable');
      },
    }),
  });
  const candidates = [
    { chunk: 'An unrelated biology passage.', score: 20 },
    { chunk: 'The momentum of an object equals mass times velocity.', score: 1 },
  ];

  const firstRanked = await reranker.rank('momentum mass velocity', candidates);
  const secondRanked = await reranker.rank('momentum mass velocity', candidates);

  assert.equal(firstRanked[0].chunk, 'The momentum of an object equals mass times velocity.');
  assert.equal(secondRanked[0].chunk, 'The momentum of an object equals mass times velocity.');
  assert.equal(calls, 1);
});

test('retains lexical-only ranking when local fallback is explicitly disabled', async () => {
  const reranker = new SemanticReranker({ localFallbackEnabled: false });
  const candidates = [
    { chunk: 'first', score: 10 },
    { chunk: 'second', score: 2 },
  ];

  const ranked = await reranker.rank('question', candidates);

  assert.deepEqual(ranked, candidates);
});
