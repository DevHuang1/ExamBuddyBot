require('dotenv').config();
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const pdfParse = require('pdf-parse');
const JSZip = require('jszip');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim();
const FIRECRAWL_API_KEY = (process.env.FIRECRAWL_API_KEY || '').trim();
const TEXT_MODEL = process.env.TEXT_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.VISION_MODEL || 'qwen/qwen3.6-27b';
const MAX_SOURCE_CHARS = parseInt(process.env.MAX_SOURCE_CHARS || '20000', 10);
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

const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = resolveFile('KEYS_FILE', 'keys.json');
const SOURCES_FILE = resolveFile('SOURCES_FILE', 'sources.json');

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
  'You are ExamBuddy, an exam-answer assistant. Answer ONLY from the uploaded lecture sources. ' +
  'If the sources do not contain the answer, say so clearly and give the best short answer from general knowledge or web results if provided. ' +
  'Be straight to the point: give the direct answer first, then a brief 1-3 sentence explanation. ' +
  'Do not add fluff, disclaimers, or filler. Format with short bullet points where useful.';

const VISION_PROMPT =
  'You are ExamBuddy. The user forwarded one or more images containing exam questions. ' +
  'Read every question clearly visible in the image(s) and answer each one directly. ' +
  'Be straight to the point: give the direct answer first, then a brief 1-3 sentence explanation. ' +
  'If any question is unreadable, say so and skip it. Format with numbered answers where there are multiple questions.';

const HELP_TEXT =
  '📚 <b>ExamBuddy Bot</b>\n\n' +
  '• <b>Forward an image</b> (question paper, homework, notes) – I read it and answer directly.\n' +
  '• <b>Send a PDF or PPTX</b> – saved as a source (with page/slide numbers) for answering questions.\n' +
  '• <b>Send a text question</b> – answered from your sources, or from the web.\n' +
  '• <b>Remembers your recent Q&amp;A</b> – follow-up questions have context.\n\n' +
  'Commands:\n' +
  '/apikey &lt;key&gt; – set your own Groq API key\n' +
  '/resetkey – go back to the preconfigured key\n' +
  '/model &lt;name&gt; – set your own text model (optional)\n' +
  '/sources – list your uploaded sources\n' +
  '/rethink – re-answer your last question\n' +
  '/clear – delete your sources and conversation memory\n' +
  '/help – this message';

const sources = new Map(); // chatId -> { pdfs: [{name,text,pages}], images: [{name,base64,mime}] }
const albums = new Map();  // mediaGroupId -> { chatId, photos: [{base64,mime}], timer }
const histories = new Map(); // chatId -> [{ role: 'user'|'assistant', content }]
const lastQuestions = new Map(); // chatId -> last text question
const MAX_HISTORY = 10;
let userKeys = {};         // chatId -> { groqKey, model }

function getHistory(chatId) {
  return histories.get(chatId) || [];
}

function pushHistory(chatId, role, content) {
  const h = histories.get(chatId) || [];
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
  histories.set(chatId, h);
}

function loadKeys() {
  try {
    if (fs.existsSync(KEYS_FILE)) userKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch (err) {
    console.error('Could not load keys file:', err.message);
  }
}

function saveKeys() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('Could not save keys file:', err.message);
  }
}

function loadSources() {
  try {
    if (fs.existsSync(SOURCES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
      for (const [chatId, store] of Object.entries(parsed)) {
        sources.set(Number(chatId), store);
      }
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
    console.error('GROQ_API_KEY is missing in .env (or users must use /apikey).');
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

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '••••••';
}

function getGroqKey(chatId) {
  const own = userKeys[chatId]?.groqKey;
  if (own) return { key: own, source: 'your own key' };
  if (GROQ_API_KEY) return { key: GROQ_API_KEY, source: 'preconfigured key' };
  return null;
}

async function groqChat({ chatId, model, systemPrompt, userText, images, history }) {
  const keyInfo = getGroqKey(chatId);
  if (!keyInfo) {
    throw new Error(
      'No Groq API key configured. Add one in .env (GROQ_API_KEY) or set yours with /apikey &lt;key&gt;',
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
    temperature: 0.4,
    max_completion_tokens: 2048,
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
    const context = truncate(
      usablePdfs
        .map((s, i) => `<source ${i + 1}> ${s.type === 'pptx' ? 'Slides' : 'PDF'} "${s.name}" (${s.pages} ${s.type === 'pptx' ? 'slides' : 'pages'})\n${truncate(s.text)}\n</source ${i + 1}>`)
        .join('\n\n'),
      MAX_SOURCE_CHARS,
    );
    const prompt = [
      SYSTEM_PROMPT,
      '\nWhen you answer from the sources, cite the source number and the page/slide number (e.g. "PDF 1, page 3" or "Slides 2, slide 5").',
      `\n\nUploaded lecture sources:\n${context}`,
      `\n\nQuestion: ${text}`,
    ].join('');
    const answer = await groqChat({ chatId, model: userKeys[chatId]?.model || TEXT_MODEL, systemPrompt: SYSTEM_PROMPT, userText: prompt, history: getHistory(chatId) });
    if (record) {
      pushHistory(chatId, 'user', text);
      pushHistory(chatId, 'assistant', answer);
    }
    const link = await findRelatedLink(text);
    await sendLong(chatId, `📚 Answered from ${usablePdfs.length + usableImages.length} source(s)\n\n`, answer);
    if (link) await send(chatId, `🔗 Similar answers: ${link}`);
  } else {
    await send(chatId, '🔎 No sources yet – searching the web…');
    const webContext = await webSearch(text);
    const prompt = `${webContext}\n\nQuestion: ${text}`;
    const answer = await groqChat({ chatId, model: userKeys[chatId]?.model || TEXT_MODEL, systemPrompt: SYSTEM_PROMPT, userText: prompt, history: getHistory(chatId) });
    if (record) {
      pushHistory(chatId, 'user', text);
      pushHistory(chatId, 'assistant', answer);
    }
    await sendLong(chatId, '🌐 Web answer (no sources uploaded)\n\n', answer);
  }
}

async function answerImages(chatId, images, caption) {
  if (!images.length) return;
  const question = caption && caption.trim() ? caption.trim() : '';
  const prompt = [
    VISION_PROMPT,
    question ? `\n\nAdditional context from the caption: ${question}` : '',
  ].join('');
  await send(chatId, `🔍 Reading ${images.length} image(s)…`);
  const answer = await groqChat({ chatId, model: VISION_MODEL, systemPrompt: VISION_PROMPT, userText: prompt, images });
  await sendLong(chatId, `🖼 Answered from forwarded image${images.length > 1 ? 's' : ''}\n\n`, answer);
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
      await answerImages(ready.chatId, ready.photos.slice(0, 6), ready.caption);
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
    const buf = await downloadFile(doc.file_id);
    const name = doc.file_name || `doc_${Date.now()}`;
    const lower = name.toLowerCase();
    const isPdf = (doc.mime_type === 'application/pdf') || lower.endsWith('.pdf');
    const isPptx = (doc.mime_type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') || lower.endsWith('.pptx');
    const store = sources.get(chatId) || { pdfs: [], images: [] };
    if (isPdf) {
      const tmp = path.join(os.tmpdir(), `exambuddy_${Date.now()}.pdf`);
      fs.writeFileSync(tmp, buf);
      const parsed = await pdfParse(fs.readFileSync(tmp), { pagerender: renderPage });
      fs.unlinkSync(tmp);
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

async function cmdApikey(chatId, args) {
  const key = (args || '').trim();
  if (!key) {
    const current = getGroqKey(chatId);
    if (current) return send(chatId, `Current key: <b>${escapeHtml(maskKey(current.key))}</b> (${current.source})`);
    return send(chatId, 'No key configured. Set one with <code>/apikey &lt;key&gt;</code> or add GROQ_API_KEY to .env.');
  }
  userKeys[chatId] = { ...(userKeys[chatId] || {}), groqKey: key };
  saveKeys();
  await send(chatId, `✅ Your own Groq key is set (${escapeHtml(maskKey(key))}). It is stored locally and used for all requests.`);
}

async function cmdResetkey(chatId) {
  if (!userKeys[chatId]) return send(chatId, 'You have no custom key set.');
  delete userKeys[chatId];
  saveKeys();
  await send(chatId, GROQ_API_KEY ? '↩️ Custom key removed. Using the preconfigured Groq key again.' : '↩️ Custom key removed. Set one with /apikey.');
}

async function cmdModel(chatId, args) {
  const model = (args || '').trim();
  if (!model) {
    const m = userKeys[chatId]?.model || TEXT_MODEL;
    return send(chatId, `Text model: <b>${escapeHtml(m)}</b> (set one with /model &lt;name&gt;)`);
  }
  userKeys[chatId] = { ...(userKeys[chatId] || {}), model };
  saveKeys();
  await send(chatId, `✅ Text model set to <b>${escapeHtml(model)}</b>.`);
}

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
  if (cmd === '/apikey' || cmd === '/api') {
    return cmdApikey(chatId, args);
  }
  if (cmd === '/resetkey') {
    return cmdResetkey(chatId);
  }
  if (cmd === '/model') {
    return cmdModel(chatId, args);
  }
  if (cmd === '/sources') {
    const store = sources.get(chatId) || { pdfs: [], images: [] };
    const lines = [];
    store.pdfs.forEach((s, i) => lines.push(`${s.type === 'pptx' ? 'Slides' : 'PDF'} ${i + 1}: ${s.name}`));
    store.images.forEach((s, i) => lines.push(`Image ${i + 1}: ${s.name}`));
    return send(chatId, lines.length ? `Your sources:\n${lines.map(escapeHtml).join('\n')}` : 'No sources yet. Send a PDF or photo.');
  }
  if (cmd === '/clear') {
    sources.delete(chatId);
    histories.delete(chatId);
    lastQuestions.delete(chatId);
    saveSources();
    return send(chatId, 'All sources and conversation memory cleared.');
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
    try {
      await handleText(chatId, text);
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
  loadKeys();
  loadSources();
  startHealthServer();
  const me = await tg('getMe', {});
  console.log(`🤖 ExamBuddy bot running as @${me.username}`);
  console.log(`Text model: ${TEXT_MODEL} | Vision model: ${VISION_MODEL}`);
  console.log(`Preconfigured Groq key: ${GROQ_API_KEY ? 'yes' : 'no (users must use /apikey)'} | ${TAVILY_API_KEY ? 'Tavily search' : 'DuckDuckGo search'}`);
  console.log(`Custom keys loaded: ${Object.keys(userKeys).length} | Keys file: ${KEYS_FILE}`);
  setInterval(poll, 1500);
  poll();
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
