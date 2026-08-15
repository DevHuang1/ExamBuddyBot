function rowsFromEmbeddings(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Feature extraction returned no embeddings.');
  if (value.every((item) => typeof item === 'number')) return [value];
  if (!value.every((item) => Array.isArray(item) && item.every((number) => typeof number === 'number'))) {
    throw new Error('Unexpected feature-extraction result format.');
  }
  return value;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return -1;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

class SemanticReranker {
  constructor({
    enabled = true,
    token = '',
    model = 'thenlper/gte-large',
    provider = 'hf-inference',
    clientFactory,
  } = {}) {
    this.enabled = enabled;
    this.token = token;
    this.model = model;
    this.provider = provider;
    this.clientFactory = clientFactory;
    this.clientPromise = null;
    this.failureLogged = false;
  }

  async getClient() {
    if (!this.enabled) throw new Error('Semantic retrieval is disabled.');
    if (!this.token) throw new Error('HF_TOKEN is not configured.');
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        if (this.clientFactory) return this.clientFactory();
        const { InferenceClient } = await import('@huggingface/inference');
        return new InferenceClient(this.token);
      })();
    }
    return this.clientPromise;
  }

  async rank(question, candidates) {
    if (!this.enabled || !Array.isArray(candidates) || candidates.length < 2 || !String(question || '').trim()) {
      return candidates;
    }
    try {
      const client = await this.getClient();
      const vectors = rowsFromEmbeddings(await client.featureExtraction({
        provider: this.provider,
        model: this.model,
        inputs: [String(question), ...candidates.map((candidate) => candidate.chunk)],
        normalize: true,
      }));
      if (vectors.length !== candidates.length + 1) throw new Error('Feature extractor returned an unexpected vector count.');
      const query = vectors[0];
      return candidates
        .map((candidate, index) => ({
          ...candidate,
          semanticScore: cosineSimilarity(query, vectors[index + 1]),
        }))
        .sort((left, right) => right.semanticScore - left.semanticScore || right.score - left.score);
    } catch (err) {
      if (!this.failureLogged) {
        console.warn(`Semantic retrieval unavailable; using lexical fallback: ${err.message}`);
        this.failureLogged = true;
      }
      return candidates;
    }
  }
}

module.exports = { SemanticReranker, cosineSimilarity, rowsFromEmbeddings };
