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

const FUZZY_STOPWORDS = new Set(
  'a an and are as at be been being but by can could did do does for from had has have he her here hers him his how i if in into is it its just may me more most my no not of on or our out she should so some that the their them then there these they this to too under up us was we were what when where which who why will with would you your'.split(/\s+/),
);

function normalizeTerm(term) {
  let value = String(term || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

function significantTerms(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(normalizeTerm)
      .filter((term) => term.length >= 3 && !FUZZY_STOPWORDS.has(term)),
  )];
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    for (let column = 0; column <= right.length; column++) previous[column] = current[column];
  }
  return previous[right.length];
}

function termSimilarity(left, right) {
  if (left === right) return 1;
  if (left.length >= 4 && right.length >= 4 && (left.startsWith(right) || right.startsWith(left))) return 0.92;
  if (Math.min(left.length, right.length) < 5) return 0;
  const distance = levenshteinDistance(left, right);
  const similarity = 1 - distance / Math.max(left.length, right.length);
  return similarity >= 0.74 ? similarity : 0;
}

function fuzzySemanticScore(question, chunk) {
  const queryTerms = significantTerms(question);
  const chunkTerms = significantTerms(chunk);
  if (!queryTerms.length || !chunkTerms.length) return 0;
  const total = queryTerms.reduce((sum, queryTerm) => {
    const best = chunkTerms.reduce((highest, chunkTerm) => Math.max(highest, termSimilarity(queryTerm, chunkTerm)), 0);
    return sum + best;
  }, 0);
  return total / queryTerms.length;
}

class SemanticReranker {
  constructor({
    enabled = true,
    token = '',
    model = 'thenlper/gte-large',
    provider = 'hf-inference',
    clientFactory,
    localFallbackEnabled = true,
  } = {}) {
    this.enabled = enabled;
    this.token = token;
    this.model = model;
    this.provider = provider;
    this.clientFactory = clientFactory;
    this.clientPromise = null;
    this.localFallbackEnabled = localFallbackEnabled;
    this.remoteAvailable = Boolean(token);
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

  rankCandidates(candidates, vectors) {
    if (vectors.length !== candidates.length + 1) throw new Error('Feature extractor returned an unexpected vector count.');
    const query = vectors[0];
    return candidates
      .map((candidate, index) => ({
        ...candidate,
        semanticScore: cosineSimilarity(query, vectors[index + 1]),
      }))
      .sort((left, right) => right.semanticScore - left.semanticScore || right.score - left.score);
  }

  async rankWithRemote(question, candidates) {
    const client = await this.getClient();
    const vectors = rowsFromEmbeddings(await client.featureExtraction({
      provider: this.provider,
      model: this.model,
      inputs: [String(question), ...candidates.map((candidate) => candidate.chunk)],
      normalize: true,
    }));
    return this.rankCandidates(candidates, vectors);
  }

  rankWithLocalFallback(question, candidates) {
    return candidates
      .map((candidate) => ({
        ...candidate,
        semanticScore: fuzzySemanticScore(question, candidate.chunk),
      }))
      .sort((left, right) => right.semanticScore - left.semanticScore || right.score - left.score);
  }

  logFallback(message) {
    if (!this.failureLogged) {
      console.warn(message);
      this.failureLogged = true;
    }
  }

  async rank(question, candidates) {
    if (!this.enabled || !Array.isArray(candidates) || candidates.length < 2 || !String(question || '').trim()) {
      return candidates;
    }

    if (this.remoteAvailable) {
      try {
        return await this.rankWithRemote(question, candidates);
      } catch (err) {
        this.remoteAvailable = false;
        if (this.localFallbackEnabled) {
          this.logFallback(`Remote semantic retrieval unavailable; using local fuzzy matching: ${err.message}`);
          return this.rankWithLocalFallback(question, candidates);
        }
        this.logFallback(`Semantic retrieval unavailable; using lexical fallback: ${err.message}`);
        return candidates;
      }
    }

    if (this.localFallbackEnabled) {
      if (!this.token) this.logFallback('HF_TOKEN is not configured; using local fuzzy semantic retrieval.');
      return this.rankWithLocalFallback(question, candidates);
    }

    this.logFallback('Semantic retrieval unavailable; using lexical fallback: HF_TOKEN is not configured and local fallback is disabled.');
    return candidates;
  }
}

module.exports = {
  SemanticReranker,
  cosineSimilarity,
  fuzzySemanticScore,
  rowsFromEmbeddings,
  significantTerms,
  termSimilarity,
};
