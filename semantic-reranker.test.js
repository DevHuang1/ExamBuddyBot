const test = require('node:test');
const assert = require('node:assert/strict');
const { SemanticReranker, cosineSimilarity } = require('./semantic-reranker');

test('computes cosine similarity for aligned vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
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

test('returns lexical candidate order when the owner Hugging Face token is unavailable', async () => {
  const reranker = new SemanticReranker();
  const candidates = [
    { chunk: 'first', score: 10 },
    { chunk: 'second', score: 2 },
  ];

  const ranked = await reranker.rank('question', candidates);

  assert.deepEqual(ranked, candidates);
});
