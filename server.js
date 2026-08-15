require('dotenv').config();
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pdfParse = require('pdf-parse');
const JSZip = require('jszip');
const { Resvg } = require('@resvg/resvg-js');
const { renderCircuit } = require('./circuit');
const { validateCircuitSpec } = require('./circuit-spec');
const { SemanticReranker } = require('./semantic-reranker');
const { normalizeQuiz, parseQuizAnswer } = require('./quiz');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim();
const FIRECRAWL_API_KEY = (process.env.FIRECRAWL_API_KEY || '').trim();
const ANSWER_MODEL = process.env.ANSWER_MODEL || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.VISION_MODEL || 'qwen/qwen3.6-27b';
const ANSWER_TEMPERATURE = Number(process.env.ANSWER_TEMPERATURE || '0.15');
const MAX_COMPLETION_TOKENS = parseInt(process.env.MAX_COMPLETION_TOKENS || '4096', 10);
const MAX_SOURCE_CHARS = parseInt(process.env.MAX_SOURCE_CHARS || '20000', 10);
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(12 * 1024 * 1024), 10);
const MAX_SOURCES_PER_CHAT = parseInt(process.env.MAX_SOURCES_PER_CHAT || '12', 10);
const MAX_VISION_IMAGES_PER_REQUEST = 5;
const MAX_SCANNED_PDF_PAGES = parseInt(process.env.MAX_SCANNED_PDF_PAGES || '15', 10);
const PDF_RENDER_DPI = parseInt(process.env.PDF_RENDER_DPI || '160', 10);
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function renderPage(pageData) {
  return pageData.getTextContent().then((text) => {
    const pageText = text.items.map((item) => item.str).join(' ');
    return `[Page ${pageData.pageNumber}] ${pageText}`;
  });
}

async function parsePptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  const parts = [];
  for (const f of slideFiles) {
    const num = parseInt(f.match(/\d+/)[0], 10);
    const xml = await zip.file(f).async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).filter((t) => t.trim());
    if (texts.length) parts.push(`[Slide ${num}] ${texts.join(' ')}`);
  }
  if (!parts.length) return null;
  return { text: parts.join('\n\n'), pages: slideFiles.length };
}

function renderScannedPdfPages(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exambuddy_pdf_'));
  const input = path.join(dir, 'source.pdf');
  const outputPrefix = path.join(dir, 'page');
  try {
    fs.writeFileSync(input, buf);
    const result = spawnSync('pdftoppm', [
      '-f', '1',
      '-l', String(MAX_SCANNED_PDF_PAGES),
      '-r', String(PDF_RENDER_DPI),
      '-png',
      input,
      outputPrefix,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || 'Unable to render the scanned PDF pages.');
    const pages = fs.readdirSync(dir)
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
      .map((name) => ({ base64: fs.readFileSync(path.join(dir, name)).toString('base64'), mime: 'image/png' }));
    return pages;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const SOURCES_FILE = resolveFile('SOURCES_FILE', 'sources.json');
const HF_RETRIEVAL_ENABLED = process.env.HF_RETRIEVAL_ENABLED !== 'false';
const HF_TOKEN = (process.env.HF_TOKEN || '').trim();
const HF_EMBEDDING_MODEL = process.env.HF_EMBEDDING_MODEL || 'thenlper/gte-large';
const HF_INFERENCE_PROVIDER = process.env.HF_INFERENCE_PROVIDER || 'hf-inference';
const semanticReranker = new SemanticReranker({
  enabled: HF_RETRIEVAL_ENABLED,
  token: HF_TOKEN,
  model: HF_EMBEDDING_MODEL,
  provider: HF_INFERENCE_PROVIDER,
});

function resolveFile(envVar, name) {
  if (process.env[envVar]) return process.env[envVar];
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, name);
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return path.join('/data', name);
  } catch {
    return path.join(DATA_DIR, name);
  }
}

function startHealthServer() {
  const port = process.env.PORT || 8080;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.listen(port, () => {
    console.log(`Health server listening on :${port}`);
  });
  server.on('error', (err) => {
    console.warn('Health server could not start:', err.message);
  });
}

const SYSTEM_PROMPT =
  'You are ExamBuddy, an expert exam-answer assistant. Treat uploaded lecture sources as the primary authority. ' +
  'For source-based answers, cite the source number and page or slide where evidence appears; never invent a citation. ' +
  'If the source does not support an answer, say that clearly before offering a carefully labelled general-knowledge or web-based explanation. ' +
  'Solve problems step by step when reasoning is needed, preserve formulas and units, check arithmetic, and distinguish facts from assumptions. ' +
  'Give a direct answer first, then a concise explanation. Do not add filler.';

const VISION_PROMPT =
  'You are ExamBuddy, an expert at full-page exam-paper detection. Treat the supplied images as ordered pages. ' +
  'Inspect each page carefully and detect every visible question number, sub-question, option, table, formula, graph, and circuit. ' +
  'Answer every readable item in page order; preserve the original numbering and explicitly mark any unreadable or cut-off text instead of guessing. ' +
  'For calculation questions, show the key steps and check arithmetic. For multiple-choice questions, state the selected option and explain briefly. ' +
  'If a circuit diagram is requested and can be represented with basic logic gates, add the required circuit JSON block exactly as instructed. ' +
  'Do not omit questions or add information that is not visible in the pages.';

const QUIZ_PROMPT =
  'You create one reliable multiple-choice practice question using ONLY the provided lecture-source context. ' +
  'Use exactly four plausible choices, put the zero-based correct choice in answerIndex, and write a brief explanation grounded in the source. ' +
  'If the source context is insufficient, set status to insufficient_source and leave all question fields as empty strings or arrays. ' +
  'Do not mention that you are an AI.';

const QUIZ_RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'exam_buddy_quiz',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'insufficient_source'] },
        topic: { type: 'string' },
        question: { type: 'string' },
        choices: { type: 'array', items: { type: 'string' } },
        answerIndex: { type: 'integer' },
        explanation: { type: 'string' },
      },
      required: ['status', 'topic', 'question', 'choices', 'answerIndex', 'explanation'],
      additionalProperties: false,
    },
  },
};

const HELP_TEXT =
  '📚 <b>ExamBuddy Bot</b>\n\n' +
  '• <b>Forward an image</b> (question paper, homework, notes) – I read it and answer directly.\n' +
  '• <b>Send a PDF or PPTX</b> – saved as a source (with page/slide numbers) for answering questions.\n' +
  '• <b>Send a text question</b> – answered from your sources, or from the web.\n' +
  '• <b>Source-grounded quizzes</b> – upload a PDF/PPTX, then use /quiz.\n' +
  '• <b>Circuit questions</b> – get a drawn diagram as an image.\n' +
  '• <b>Remembers your recent Q&amp;A</b> – follow-up questions have context.\n\n' +
  'Commands:\n' +
  '/sources – list your uploaded sources\n' +
  '/quiz [topic] – create one practice question from your sources\n' +
  '/rethink – re-answer your last question\n' +
  '/clear – delete your sources and conversation memory\n' +
  '/help – this message';

const sources = new Map(); // chatId -> { pdfs: [{name,text,pages}], images: [{name,base64,mime}] }
const albums = new Map();  // mediaGroupId -> { chatId, photos: [{base64,mime}], timer }
const histories = new Map(); // chatId -> [{ role: 'user'|'assistant', content }]
const lastQuestions = new Map(); // chatId -> last text question
const activeQuizzes = new Map(); // chatId -> validated multiple-choice quiz
const MAX_HISTORY = 10;

function getHistory(chatId) {
  return histories.get(chatId) || [];
}

function pushHistory(chatId, role, content) {
  const h = histories.get(chatId) || [];
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
  histories.set(chatId, h);
}

function loadSources() {
  try {
    if (fs.existsSync(SOURCES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
      for (const [chatId, store] of Object.entries(parsed)) {
        sources.set(Number(chatId), store);
      }
      console.log(`Loaded sources from ${SOURCES_FILE}: ${Object.keys(parsed).length} chat(s) with sources.`);
    } else {
      console.log(`No sources file at ${SOURCES_FILE} yet — starting fresh.`);
    }
  } catch (err) {
    console.error('Could not load sources file:', err.message);
  }
}

function saveSources() {
  try {
    const dir = path.dirname(SOURCES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = {};
    for (const [chatId, store] of sources) obj[chatId] = store;
    fs.writeFileSync(SOURCES_FILE, JSON.stringify(obj), { mode: 0o600 });
    console.log(`Saved sources to ${SOURCES_FILE}: ${Object.keys(obj).length} chat(s).`);
  } catch (err) {
    console.error('Could not save sources file:', err.message);
  }
}

function requireConfig() {
  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY is missing. Configure the owner-managed deployment secret before starting the bot.');
    process.exit(1);
  }
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function sendPhoto(chatId, png, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([png], { type: 'image/png' }), 'circuit.png');
  if (caption) form.append('caption', caption);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'sendPhoto failed');
}

function maybeDiagram(text) {
  return /circuit|diagram|schematic|\bgate\b|adder|subtracter|subtractor|flip-?flop|latch|multiplexer|demultiplexer|demux|encoder|decoder|counter|register|waveform|timing diagram|block diagram|\bdraw\b|\bsketch\b|show (me )?the circuit|truth table|karnaugh|k-?map/i.test(text);
}

const DIAGRAM_HINT =
  '\nIf a circuit diagram is needed, give the normal written answer first, then include exactly one ```circuit JSON block. ' +
  'Use this exact shape: {"inputs":["A","B"],"outputs":["S","Cout"],"gates":[{"id":"g1","type":"xor","inputs":["A","B"],"output":"S"},{"id":"g2","type":"and","inputs":["A","B"],"output":"Cout"}]}. ' +
  'Supported component types are and, or, not, xor, nand, nor, xnor, buffer, mux2, mux4, dff, jkff, tff, and srff. List components in dependency order; every component input must be an original input or a signal produced by an earlier component. ' +
  'Use one input for not/buffer; two to four inputs for basic logic gates; mux2 inputs [I0,I1,S]; mux4 inputs [I0,I1,I2,I3,S0,S1]; dff inputs [D,CLK]; jkff inputs [J,K,CLK]; tff inputs [T,CLK]; and srff inputs [S,R,CLK]. ' +
  'Use short unique signal names and output Q for flip-flops where appropriate. Do not generate timing diagrams or unsupported component types.';

async function renderDiagramPng(spec) {
  const svg = await renderCircuit(spec);
  if (!svg) return null;
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1100 },
    font: {
      fontFiles: [path.join(__dirname, 'fonts', 'DejaVuSans.ttf')],
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Sans',
    },
  });
  return r.render().asPng();
}

async function extractAndSendDiagram(chatId, answer) {
  const m = answer.match(/```(?:circuit|json)\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const spec = validateCircuitSpec(JSON.parse(m[1].trim()));
    const png = await renderDiagramPng(spec);
    if (!png) return null;
    await sendPhoto(chatId, png, '⚙️ Circuit diagram');
    return true;
  } catch (err) {
    console.error('Diagram render failed:', err.message);
    return null;
  }
}

function stripDotBlock(answer) {
  return String(answer).replace(/```(?:dot|graphviz|circuit|json)\n[\s\S]*?```/g, '').trim();
}

async function send(chatId, text) {
  await tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendLong(chatId, header, text) {
  const escaped = escapeHtml(text);
  const chunks = [];
  let rest = String(escaped);
  while (rest.length > 3800) {
    let cut = rest.lastIndexOf('\n', 3800);
    if (cut < 1500) cut = 3800;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  const capped = chunks.slice(0, 8);
  for (let i = 0; i < capped.length; i++) {
    await send(chatId, (i === 0 ? header : '') + capped[i]);
  }
  if (chunks.length > capped.length) {
    await send(chatId, '…[answer truncated, too long]');
  }
}

function quizMessage(quiz) {
  const letters = ['A', 'B', 'C', 'D'];
  const choices = quiz.choices.map((choice, index) => `<b>${letters[index]}.</b> ${escapeHtml(choice)}`).join('\n');
  return `📝 <b>Practice quiz: ${escapeHtml(quiz.topic)}</b>\n\n${escapeHtml(quiz.question)}\n\n${choices}\n\nReply with A, B, C, or D.`;
}

async function createQuiz(chatId, topic) {
  const store = sources.get(chatId) || { pdfs: [], images: [] };
  const context = await buildContext(store.pdfs, topic || 'practice question', MAX_SOURCE_CHARS);
  if (!context) {
    await send(chatId, '📝 To create a reliable quiz, first upload a PDF or PPTX source. Then use <code>/quiz</code> or <code>/quiz &lt;topic&gt;</code>.');
    return;
  }

  await typing(chatId);
  const request = [
    `Requested focus: ${topic || 'choose an important concept from the uploaded sources'}.`,
    'Lecture-source context:',
    context,
  ].join('\n\n');
  const raw = await groqChat({
    chatId,
    model: ANSWER_MODEL,
    systemPrompt: QUIZ_PROMPT,
    userText: request,
    history: [],
    responseFormat: QUIZ_RESPONSE_SCHEMA,
  });
  let quiz;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed?.status === 'insufficient_source') throw new Error('The uploaded sources do not contain enough material for a reliable quiz on that topic.');
    quiz = normalizeQuiz(parsed);
  } catch (err) {
    throw new Error(`Quiz creation failed safely: ${err.message}`);
  }
  activeQuizzes.set(chatId, quiz);
  await send(chatId, quizMessage(quiz));
}

async function handleQuizAnswer(chatId, answerIndex) {
  const quiz = activeQuizzes.get(chatId);
  if (!quiz) return false;
  activeQuizzes.delete(chatId);
  const correct = answerIndex === quiz.answerIndex;
  const letters = ['A', 'B', 'C', 'D'];
  const result = correct ? '✅ <b>Correct.</b>' : `❌ <b>Not quite.</b> The correct answer is <b>${letters[quiz.answerIndex]}. ${escapeHtml(quiz.choices[quiz.answerIndex])}</b>.`;
  await send(chatId, `${result}\n\n<b>Why:</b> ${escapeHtml(quiz.explanation)}\n\nUse <code>/quiz</code> for another source-grounded question.`);
  return true;
}

async function typing(chatId) {
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {}
}

async function downloadFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download file from Telegram');
  return Buffer.from(await res.arrayBuffer());
}

function truncate(text, max = 40000) {
  return text.length > max ? text.slice(0, max) + '\n…[truncated]' : text;
}

const STOPWORDS = new Set(
  'a an and or of in on for to is are was were be been being this that these those with from by at as it its i you we they he she them their have has had do does did not no yes but if then else than so such can could will would may might must should about into over under between during after before above below up down out off again once here there when where why how all any both each few more most other some own only too very just because into via'.split(/\s+/),
);

function keywordMap(text) {
  const map = new Map();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    map.set(w, (map.get(w) || 0) + 1);
  }
  return map;
}

function chunkText(text, size = 900) {
  const parts = String(text || '').split(/(?=\[Page \d+\]|\[Slide \d+\])/);
  const chunks = [];
  let current = '';
  for (const p of parts) {
    if (current && (current + p).length > size) {
      chunks.push(current);
      current = p;
    } else {
      current += p;
    }
    while (current.length > size) {
      chunks.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function chunkLabel(s, num, chunk) {
  const kind = s.type === 'pptx' ? 'Slides' : 'PDF';
  return `<source ${num}> ${kind} "${s.name}"\n${chunk}\n</source ${num}>`;
}

async function buildContext(sources, question, maxChars) {
  const qkeys = keywordMap(question);
  const scored = [];
  sources.forEach((s, i) => {
    const nameKeys = keywordMap(s.name);
    chunkText(s.text).forEach((chunk, j) => {
      const ckeys = keywordMap(chunk);
      let score = 0;
      for (const [k, q] of qkeys) if (ckeys.has(k)) score += q * 3;
      for (const [k] of nameKeys) if (ckeys.has(k)) score += 5;
      scored.push({ i, j, chunk, score });
    });
  });
  if (!scored.length) return '';

  const used = new Set();
  const chosen = [];
  let totalLen = 0;
  const addChunk = (c) => {
    if (used.has(c)) return false;
    const item = chunkLabel(sources[c.i], c.i + 1, c.chunk);
    if (totalLen + item.length > maxChars) return false;
    used.add(c);
    chosen.push(c);
    totalLen += item.length;
    return true;
  };

  const ranked = await semanticReranker.rank(question, scored);
  const compare = (a, b) => {
    const semanticDelta = (b.semanticScore ?? -Infinity) - (a.semanticScore ?? -Infinity);
    return semanticDelta || b.score - a.score;
  };
  const bySource = new Map();
  for (const c of ranked) {
    if (!bySource.has(c.i)) bySource.set(c.i, []);
    bySource.get(c.i).push(c);
  }
  for (const list of bySource.values()) {
    list.sort(compare);
    addChunk(list[0]);
  }
  const rest = [...ranked].sort(compare);
  for (const c of rest) {
    if (!addChunk(c)) break;
  }
  chosen.sort((a, b) => a.i - b.i || a.j - b.j);
  return chosen.map((c) => chunkLabel(sources[c.i], c.i + 1, c.chunk)).join('\n\n');
}

function getGroqKey() {
  if (GROQ_API_KEY) return { key: GROQ_API_KEY, source: 'owner-managed deployment key' };
  return null;
}

async function groqChat({ chatId, model, systemPrompt, userText, images, history, responseFormat }) {
  const keyInfo = getGroqKey();
  if (!keyInfo) {
    throw new Error(
      'This bot is not configured yet. The owner must add the GROQ_API_KEY deployment secret.',
    );
  }
  const content = [{ type: 'text', text: userText }];
  for (const img of images || []) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } });
  }
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of history || []) {
    if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content });
  const body = JSON.stringify({
    model,
    messages,
    temperature: ANSWER_TEMPERATURE,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keyInfo.key}`,
      },
      body,
    });
    const data = await res.json();
    if (res.ok) {
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error('Groq returned an empty answer.');
      return answer;
    }
    const msg = data.error?.message || `Groq error (HTTP ${res.status})`;
    const transient = res.status === 429 || /rate limit|tokens? per minute|TPM|RPM/i.test(msg);
    if (transient && attempt < 3) {
      await delay(attempt * 30000);
      continue;
    }
    throw new Error(msg);
  }
}

async function firecrawlSearch(query) {
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ query, limit: 5, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } }),
  });
  if (!res.ok) throw new Error(`Firecrawl search failed (HTTP ${res.status}).`);
  const data = await res.json();
  const results = (data.data || []).filter((r) => r.url && (r.title || r.description || r.markdown));
  if (!results.length) throw new Error('No useful web results found.');

  const pieces = [];
  for (const r of results.slice(0, 2)) {
    if (r.markdown && r.markdown.trim()) {
      pieces.push(`Source: ${r.title || r.url}\n${truncate(r.markdown, 4000)}`);
    } else if (r.description) {
      pieces.push(`${r.title || r.url}: ${r.description}`);
    }
  }
  for (const r of results.slice(2)) {
    if (r.title && r.description) pieces.push(`${r.title}: ${r.description}`);
  }
  if (!pieces.length) throw new Error('No useful web results found.');
  return pieces.join('\n\n');
}

async function findRelatedLink(question) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(question)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/);
    if (!m) return null;
    let link = m[1];
    if (link.startsWith('//')) link = `https:${link}`;
    const uddg = link.match(/uddg=([^&]+)/);
    if (uddg) link = decodeURIComponent(uddg[1]);
    return link || null;
  } catch {
    return null;
  }
}

async function webSearch(query) {
  if (FIRECRAWL_API_KEY) return firecrawlSearch(query);
  if (TAVILY_API_KEY) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query, search_depth: 'basic', max_results: 4, include_answer: true }),
    });
    if (res.ok) {
      const data = await res.json();
      const pieces = [];
      if (data.answer) pieces.push(`Summary: ${data.answer}`);
      for (const r of data.results || []) if (r.title && r.content) pieces.push(`${r.title}: ${r.content}`);
      if (pieces.length) return pieces.slice(0, 4).join('\n');
    }
  }
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error('Web search failed.');
  const html = await res.text();
  const pieces = [];
  const re = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && pieces.length < 5) {
    const title = stripTags(m[1]);
    const snippet = stripTags(m[2]);
    if (title && snippet) pieces.push(`${title}: ${snippet}`);
  }
  if (!pieces.length) throw new Error('No useful web results found.');
  return pieces.join('\n');
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- handlers ----------

async function handleText(chatId, text, { record = true } = {}) {
  const store = sources.get(chatId) || { pdfs: [], images: [] };
  const usablePdfs = store.pdfs;
  const usableImages = store.images;

  lastQuestions.set(chatId, text);
  await typing(chatId);

  if (usablePdfs.length || usableImages.length) {
    const context = await buildContext(usablePdfs, text, MAX_SOURCE_CHARS);
    const images = usableImages.slice(0, 4);
    const sourceCount = usablePdfs.length + usableImages.length;
    const prompt = [
      SYSTEM_PROMPT,
      '\nWhen you answer from the sources, cite the source number and the page/slide number (e.g. "PDF 1, page 3" or "Slides 2, slide 5").',
      maybeDiagram(text) ? DIAGRAM_HINT : '',
      context ? `\n\nUploaded lecture sources:\n${context}` : '',
      images.length ? `\n\n${images.length} uploaded image source(s) are attached — read them and use them to answer.` : '',
      `\n\nQuestion: ${text}`,
    ].filter(Boolean).join('');
    if (usablePdfs.length && !context && !images.length) {
      console.error(`No usable text extracted from PDF sources for chat ${chatId} (question: "${text.slice(0, 60)}")`);
    }
    const answer = await groqChat({
      chatId,
      model: images.length ? VISION_MODEL : ANSWER_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      userText: prompt,
      images,
      history: getHistory(chatId),
    });
    if (record) {
      pushHistory(chatId, 'user', text);
      pushHistory(chatId, 'assistant', stripDotBlock(answer));
    }
    await sendLong(chatId, `📚 Answered from ${sourceCount} source(s)\n\n`, stripDotBlock(answer));
    await extractAndSendDiagram(chatId, answer);
    const link = await findRelatedLink(text);
    if (link) await send(chatId, `🔗 Similar answers: ${link}`);
  } else {
    await send(chatId, '🔎 No sources found for this chat yet – searching the web…\n(Send a PDF/PPTX or an image to add a source; check /sources.)');
    const webContext = await webSearch(text);
    const prompt = `${webContext}\n\n${maybeDiagram(text) ? DIAGRAM_HINT + '\n' : ''}Question: ${text}`;
    const answer = await groqChat({ chatId, model: ANSWER_MODEL, systemPrompt: SYSTEM_PROMPT, userText: prompt, history: getHistory(chatId) });
    if (record) {
      pushHistory(chatId, 'user', text);
      pushHistory(chatId, 'assistant', stripDotBlock(answer));
    }
    await sendLong(chatId, '🌐 Web answer (no sources uploaded)\n\n', stripDotBlock(answer));
    await extractAndSendDiagram(chatId, answer);
  }
}

async function answerImages(chatId, images, caption) {
  if (!images.length) return;
  const question = caption && caption.trim() ? caption.trim() : '';
  const batches = [];
  await send(chatId, `🔍 Reading ${images.length} image(s) in page order…`);

  for (let start = 0; start < images.length; start += MAX_VISION_IMAGES_PER_REQUEST) {
    const batch = images.slice(start, start + MAX_VISION_IMAGES_PER_REQUEST);
    const end = start + batch.length;
    const prompt = [
      VISION_PROMPT,
      `This request contains image page(s) ${start + 1}-${end} of ${images.length}.`,
      question ? `Additional context from the caption: ${question}` : '',
    ].filter(Boolean).join('\n\n');
    const answer = await groqChat({
      chatId,
      model: VISION_MODEL,
      systemPrompt: VISION_PROMPT,
      userText: prompt,
      images: batch,
      history: [],
    });
    batches.push(images.length > MAX_VISION_IMAGES_PER_REQUEST ? `Pages ${start + 1}-${end}:\n${answer}` : answer);
  }

  await sendLong(chatId, `🖼 Answered from forwarded image${images.length > 1 ? 's' : ''}\n\n`, batches.join('\n\n'));
}

async function grabPhoto(chatId, photo) {
  const largest = photo[photo.length - 1];
  const buf = await downloadFile(largest.file_id);
  const mime = largest.mime_type || 'image/jpeg';
  return { base64: buf.toString('base64'), mime };
}

function scheduleAlbum(mediaGroupId) {
  const album = albums.get(mediaGroupId);
  clearTimeout(album.timer);
  album.timer = setTimeout(async () => {
    const ready = albums.get(mediaGroupId);
    if (!ready) return;
    albums.delete(mediaGroupId);
    try {
      await answerImages(ready.chatId, ready.photos, ready.caption);
    } catch (err) {
      await send(ready.chatId, `⚠️ Error: ${escapeHtml(err.message)}`).catch(() => {});
    }
  }, 1400);
}

async function handlePhoto(chatId, photo, caption, mediaGroupId) {
  try {
    const img = await grabPhoto(chatId, photo);
    if (mediaGroupId) {
      const existing = albums.get(mediaGroupId);
      if (existing) {
        existing.photos.push(img);
        if (!existing.caption && caption) existing.caption = caption;
        scheduleAlbum(mediaGroupId);
        return;
      }
      const album = { chatId, photos: [img], caption: caption || '', timer: null };
      albums.set(mediaGroupId, album);
      scheduleAlbum(mediaGroupId);
      return;
    }
    await answerImages(chatId, [img], caption);
  } catch (err) {
    await send(chatId, `⚠️ Error: ${escapeHtml(err.message)}`).catch(() => {});
  }
}

async function handleDocument(chatId, doc) {
  try {
    if (doc.file_size && doc.file_size > MAX_UPLOAD_BYTES) {
      throw new Error(`That file is too large. Please send a file smaller than ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`);
    }
    const store = sources.get(chatId) || { pdfs: [], images: [] };
    const sourceCount = store.pdfs.length + store.images.length;
    if (sourceCount >= MAX_SOURCES_PER_CHAT) {
      throw new Error(`You have reached the source limit (${MAX_SOURCES_PER_CHAT}). Use /clear before adding more files.`);
    }
    const buf = await downloadFile(doc.file_id);
    const name = doc.file_name || `doc_${Date.now()}`;
    const lower = name.toLowerCase();
    const isPdf = (doc.mime_type === 'application/pdf') || lower.endsWith('.pdf');
    const isPptx = (doc.mime_type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') || lower.endsWith('.pptx');
    if (isPdf) {
      const tmp = path.join(os.tmpdir(), `exambuddy_${Date.now()}.pdf`);
      let parsed = null;
      try {
        fs.writeFileSync(tmp, buf);
        parsed = await pdfParse(fs.readFileSync(tmp), { pagerender: renderPage });
      } catch (err) {
        console.warn(`Text extraction failed for ${name}; trying vision fallback:`, err.message);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      if (!parsed?.text || !parsed.text.trim()) {
        const pages = renderScannedPdfPages(buf);
        if (!pages.length) throw new Error('No readable pages could be rendered from that PDF.');
        await send(chatId, `📷 This is a scanned PDF, so I am reading its first ${pages.length} page(s) with full-page vision detection.`);
        await answerImages(chatId, pages, `Scanned PDF: ${name}`);
        return;
      }
      store.pdfs.push({ name, text: parsed.text, pages: parsed.numPages, type: 'pdf' });
      sources.set(chatId, store);
      saveSources();
      await send(chatId, `📄 Added "${escapeHtml(name)}" as PDF source (${store.pdfs.length} PDF source(s)). Ask me a question now.`);
    } else if (isPptx) {
      const parsed = await parsePptx(buf);
      if (!parsed || !parsed.text.trim()) {
        throw new Error('No readable text found in that PPTX (it may be image-only slides).');
      }
      store.pdfs.push({ name, text: parsed.text, pages: parsed.pages, type: 'pptx' });
      sources.set(chatId, store);
      saveSources();
      await send(chatId, `📊 Added "${escapeHtml(name)}" as slides source (${store.pdfs.length} source(s), ${parsed.pages} slides). Ask me a question now.`);
    } else {
      const mime = doc.mime_type || 'image/jpeg';
      store.images.push({ name, base64: buf.toString('base64'), mime });
      sources.set(chatId, store);
      saveSources();
      await send(chatId, `🖼 Added "${escapeHtml(name)}" as image source (${store.images.length} image source(s)). Ask me a question now.`);
    }
  } catch (err) {
    await send(chatId, `⚠️ Error: ${escapeHtml(err.message)}`).catch(() => {});
  }
}

// ---------- commands ----------

// ---------- update dispatch ----------

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (msg.photo) {
    return handlePhoto(chatId, msg.photo, msg.caption, msg.media_group_id);
  }
  if (msg.document) {
    return handleDocument(chatId, msg.document);
  }

  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(' ');

  if (cmd === '/start') {
    return send(chatId, `👋 Hello! I am <b>ExamBuddy</b>.\n\n${HELP_TEXT}`);
  }
  if (cmd === '/help') {
    return send(chatId, HELP_TEXT);
  }
  if (cmd === '/apikey' || cmd === '/api' || cmd === '/resetkey' || cmd === '/model') {
    return send(chatId, '🔒 You do not need an API key or model command. ExamBuddy uses the owner-managed high-quality model configuration.');
  }
  if (cmd === '/sources') {
    const store = sources.get(chatId) || { pdfs: [], images: [] };
    const lines = [];
    store.pdfs.forEach((s, i) => lines.push(`${s.type === 'pptx' ? 'Slides' : 'PDF'} ${i + 1}: ${s.name}`));
    store.images.forEach((s, i) => lines.push(`Image ${i + 1}: ${s.name}`));
    return send(chatId, lines.length ? `Your sources:\n${lines.map(escapeHtml).join('\n')}` : 'No sources yet. Send a PDF or photo.');
  }
  if (cmd === '/quiz') {
    try {
      return await createQuiz(chatId, args);
    } catch (err) {
      return send(chatId, `⚠️ ${escapeHtml(err.message)}`).catch(() => {});
    }
  }
  if (cmd === '/clear') {
    sources.delete(chatId);
    histories.delete(chatId);
    lastQuestions.delete(chatId);
    activeQuizzes.delete(chatId);
    saveSources();
    return send(chatId, 'All sources, conversation memory, and active quiz state cleared.');
  }
  if (cmd === '/rethink' || cmd === '/redo' || cmd === '/retry' || cmd === '/pyanloke') {
    const q = lastQuestions.get(chatId);
    if (!q) return send(chatId, 'No previous question to rethink. Ask me something first.');
    try {
      await handleText(chatId, q, { record: false });
    } catch (err) {
      await send(chatId, `⚠️ Error: ${escapeHtml(err.message)}`).catch(() => {});
    }
    return;
  }
  if (text && !text.startsWith('/')) {
    const quizAnswer = activeQuizzes.has(chatId) ? parseQuizAnswer(text) : null;
    try {
      if (quizAnswer !== null) {
        await handleQuizAnswer(chatId, quizAnswer);
      } else {
        await handleText(chatId, text);
      }
    } catch (err) {
      await send(chatId, `⚠️ Error: ${escapeHtml(err.message)}`).catch(() => {});
    }
  }
}

// ---------- polling ----------

let offset = 0;
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const updates = await tg('getUpdates', { offset, timeout: 30 });
    for (const update of updates) {
      offset = update.update_id + 1;
      handleUpdate(update).catch(() => {});
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  } finally {
    polling = false;
  }
}

async function main() {
  requireConfig();
  loadSources();
  startHealthServer();
  const me = await tg('getMe', {});
  console.log(`🤖 ExamBuddy bot running as @${me.username}`);
  console.log(`Answer model: ${ANSWER_MODEL} | Vision model: ${VISION_MODEL}`);
  console.log(`Owner-managed Groq key: ${GROQ_API_KEY ? 'configured' : 'missing'} | ${TAVILY_API_KEY ? 'Tavily search' : 'DuckDuckGo search'}`);
  console.log(`Hugging Face semantic retrieval: ${HF_RETRIEVAL_ENABLED && HF_TOKEN ? `${HF_EMBEDDING_MODEL} via ${HF_INFERENCE_PROVIDER}` : 'lexical fallback only'}`);
  console.log(`Source store: ${SOURCES_FILE}`);
  setInterval(poll, 1500);
  poll();
}

function resetTestState() {
  sources.clear();
  albums.clear();
  histories.clear();
  lastQuestions.clear();
  activeQuizzes.clear();
  offset = 0;
  polling = false;
}

module.exports = {
  handleUpdate,
  __test: {
    activeQuizzes,
    answerImages,
    extractAndSendDiagram,
    resetTestState,
    sources,
  },
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}
