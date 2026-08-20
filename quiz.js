function stripCodeFence(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonObject(value) {
  const text = stripCodeFence(value);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The quiz generator did not return valid JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeQuiz(value) {
  const raw = typeof value === 'string' ? extractJsonObject(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The quiz generator returned an invalid question.');
  }

  const question = cleanText(raw.question, 1200);
  const choices = Array.isArray(raw.choices) ? raw.choices.map((choice) => cleanText(choice, 420)) : [];
  const answerIndex = Number(raw.answerIndex);
  const explanation = cleanText(raw.explanation, 1600);
  const topic = cleanText(raw.topic, 160) || 'Practice question';

  if (!question || choices.length !== 4 || choices.some((choice) => !choice) || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3 || !explanation) {
    throw new Error('The quiz generator returned an incomplete question.');
  }

  return { question, choices, answerIndex, explanation, topic };
}

function normalizeFlashcards(value) {
  const raw = typeof value === 'string' ? extractJsonObject(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The flashcard generator returned an invalid response.');
  }

  const topic = cleanText(raw.topic, 160) || 'Study review';
  const cards = Array.isArray(raw.cards) ? raw.cards.map((card) => ({
    front: cleanText(card?.front, 500),
    back: cleanText(card?.back, 1000),
    source: cleanText(card?.source, 240),
  })) : [];
  const hasSourceCitation = (source) => /(?:PDF|Slides)\s+\d+.*(?:page|slide)\s+\d+/i.test(source);

  if (cards.length !== 5 || cards.some((card) => !card.front || !card.back || !hasSourceCitation(card.source))) {
    throw new Error('The flashcard generator returned incomplete or uncited cards.');
  }

  return { topic, cards };
}

function normalizeStudyGuide(value) {
  const raw = typeof value === 'string' ? extractJsonObject(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The study guide generator returned an invalid response.');
  }

  const topic = cleanText(raw.topic, 160) || 'Study review';
  const overview = cleanText(raw.overview, 1600);
  const keyPoints = Array.isArray(raw.keyPoints) ? raw.keyPoints.map((item) => ({
    point: cleanText(item?.point, 500),
    source: cleanText(item?.source, 240),
  })) : [];
  const examTips = Array.isArray(raw.examTips) ? raw.examTips.map((tip) => cleanText(tip, 400)) : [];
  const studyPlan = Array.isArray(raw.studyPlan) ? raw.studyPlan.map((step) => cleanText(step, 400)) : [];
  const hasSourceCitation = (source) => /(?:PDF|Slides)\s+\d+.*(?:page|slide)\s+\d+/i.test(source);

  if (!overview || keyPoints.length !== 5 || keyPoints.some((item) => !item.point || !hasSourceCitation(item.source)) ||
    examTips.length !== 3 || examTips.some((tip) => !tip) || studyPlan.length !== 3 || studyPlan.some((step) => !step)) {
    throw new Error('The study guide generator returned incomplete or uncited content.');
  }

  return { topic, overview, keyPoints, examTips, studyPlan };
}

function parseQuizAnswer(value) {
  const text = String(value || '').trim().toUpperCase();
  const letter = text.match(/^([A-D])(?:[.)\s]|$)/);
  if (letter) return letter[1].charCodeAt(0) - 65;
  const number = text.match(/^([1-4])(?:[.)\s]|$)/);
  if (number) return Number(number[1]) - 1;
  return null;
}

module.exports = { extractJsonObject, normalizeFlashcards, normalizeQuiz, normalizeStudyGuide, parseQuizAnswer };
