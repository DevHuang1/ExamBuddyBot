require('dotenv').config();
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const pdfParse = require('pdf-parse');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim();
const TEXT_MODEL = process.env.TEXT_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.VISION_MODEL || 'llama-3.2-90b-vision-preview';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = resolveKeysFile();

function resolveKeysFile() {
  if (process.env.KEYS_FILE) return process.env.KEYS_FILE;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'keys.json');
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return path.join('/data', 'keys.json');
  } catch {
    return path.join(DATA_DIR, 'keys.json');
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
  '• <b>Send a PDF</b> – saved as a lecture source for questions.\n' +
  '• <b>Send a text question</b> – answered from your sources, or from the web.\n\n' +
  'Commands:\n' +
  '/apikey &lt;key&gt; – set your own Groq API key\n' +
  '/resetkey – go back to the preconfigured key\n' +
  '/model &lt;name&gt; – set your own text model (optional)\n' +
  '/sources – list your uploaded sources\n' +
  '/clear – delete your sources\n' +
  '/help – this message';

const sources = new Map(); // chatId -> { pdfs: [{name,text}], images: [{name,base64,mime}] }
const albums = new Map();  // mediaGroupId -> { chatId, photos: [{base64,mime}], timer }
let userKeys = {};         // chatId -> { groqKey, model }

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

async function groqChat({ chatId, model, systemPrompt, userText, images }) {
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
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keyInfo.key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      temperature: 0.4,
      max_completion_tokens: 2048,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Groq error (HTTP ${res.status})`);
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('Groq returned an empty answer.');
  return answer;
}

async function webSearch(query) {
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
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url);
  const data = await res.json();
  const pieces = [];
  if (data.AbstractText) pieces.push(`${data.Heading || 'Result'}: ${data.AbstractText}`);
  const flatten = (topics) => {
    for (const t of topics || []) {
      if (t.Text) pieces.push(t.Text);
      if (t.Topics) flatten(t.Topics);
    }
  };
  flatten(data.RelatedTopics);
  if (!pieces.length) throw new Error('No useful web results found.');
  return pieces.slice(0, 5).join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- handlers ----------

async function handleText(chatId, text) {
  const store = sources.get(chatId) || { pdfs: [], images: [] };
  const usablePdfs = store.pdfs;
  const usableImages = store.images;

  await typing(chatId);

  if (usablePdfs.length || usableImages.length) {
    const context = usablePdfs
      .map((s, i) => `<source ${i + 1}> PDF "${s.name}"\n${truncate(s.text)}\n</source ${i + 1}>`)
      .join('\n\n');
    const prompt = [
      SYSTEM_PROMPT,
      `\n\nUploaded lecture sources:\n${context}`,
      `\n\nQuestion: ${text}`,
    ].join('');
    const answer = await groqChat({ chatId, model: userKeys[chatId]?.model || TEXT_MODEL, systemPrompt: SYSTEM_PROMPT, userText: prompt });
    await send(chatId, `📚 Answered from ${usablePdfs.length + usableImages.length} source(s)\n\n${escapeHtml(answer)}`);
  } else {
    await send(chatId, '🔎 No sources yet – searching the web…');
    const webContext = await webSearch(text);
    const prompt = `${webContext}\n\nQuestion: ${text}`;
    const answer = await groqChat({ chatId, model: userKeys[chatId]?.model || TEXT_MODEL, systemPrompt: SYSTEM_PROMPT, userText: prompt });
    await send(chatId, `🌐 Web answer (no sources uploaded)\n\n${escapeHtml(answer)}`);
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
  await send(chatId, `🖼 Answered from forwarded image${images.length > 1 ? 's' : ''}\n\n${escapeHtml(answer)}`);
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
    const isPdf = (doc.mime_type === 'application/pdf') || name.toLowerCase().endsWith('.pdf');
    const store = sources.get(chatId) || { pdfs: [], images: [] };
    if (isPdf) {
      const tmp = path.join(os.tmpdir(), `exambuddy_${Date.now()}.pdf`);
      fs.writeFileSync(tmp, buf);
      const parsed = await pdfParse(fs.readFileSync(tmp));
      fs.unlinkSync(tmp);
      store.pdfs.push({ name, text: parsed.text });
      sources.set(chatId, store);
      await send(chatId, `📄 Added "${escapeHtml(name)}" as PDF source (${store.pdfs.length} PDF source(s)). Ask me a question now.`);
    } else {
      const mime = doc.mime_type || 'image/jpeg';
      store.images.push({ name, base64: buf.toString('base64'), mime });
      sources.set(chatId, store);
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
    store.pdfs.forEach((s, i) => lines.push(`PDF ${i + 1}: ${s.name}`));
    store.images.forEach((s, i) => lines.push(`Image ${i + 1}: ${s.name}`));
    return send(chatId, lines.length ? `Your sources:\n${lines.map(escapeHtml).join('\n')}` : 'No sources yet. Send a PDF or photo.');
  }
  if (cmd === '/clear') {
    sources.delete(chatId);
    return send(chatId, 'All sources cleared.');
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
