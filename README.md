# ExamBuddyBot

Telegram bot that answers exam questions from forwarded images, uploaded sources (PDFs/images), or web search. The deployment owner configures the model credentials once; students never need to provide API keys. It uses GPT-OSS 120B for high-quality text reasoning and Qwen 3.6 27B for vision-based page detection.

## Features

- 📷 **Forward images or albums** (question papers, homework, notes) — pages are processed in order, with every readable question, option, formula, table, and circuit detected.
- 📄 **Send a PDF or PPTX** — text PDFs/PPTX files are saved as cited lecture sources; image-only PDFs automatically fall back to full-page vision detection in bounded batches.
- ✍️ **Send a text question** — answered from your uploaded sources, or from the web (Firecrawl / Tavily / DuckDuckGo) only when no sources are present. Source-backed questions stay source-only and are not sent to a search engine.
- 📝 **Source-grounded quizzes and revision guides** — use `/quiz [topic]` for validated multiple-choice practice and `/studyguide [topic]` for an exam-ready overview, cited key points, practical tips, and a three-step study plan from uploaded PDF/PPTX sources.
- 📈 **Private quiz analytics** — accuracy and adaptive study-focus analytics persist across restarts until the learner confirms `/clear`.
- 📖 **Resilient source retrieval** — answers use Hugging Face semantic embeddings when an owner token is configured, then fall back to local typo-tolerant fuzzy matching without sending source text to another provider. Lexical ranking remains available as an explicit opt-out fallback. Source material is treated as reference data, never as bot instructions.
- ⚙️ **Validated circuit diagrams** — the bot validates every signal, component pin count, bit width, and dependency before drawing clean symbols and wires. It supports basic logic, 2:1 and 4:1 multiplexers, D/JK/T/SR flip-flops, 2-to-4 and 3-to-8 decoders, 4-to-2 and 8-to-3 encoders, plus configurable 2–32 bit registers with visible clock-edge markers. Unsupported timing diagrams still receive an explanation rather than a fabricated waveform.
- 💬 **Conversation memory** — remembers recent Q&A so follow-up questions have context, while per-chat update processing keeps rapid messages and replies in order.
- 👥 **Group-safe workspaces** — in groups and supergroups, every participant has separate sources, recent history, quiz state, analytics, and message queue. One learner’s long study task does not delay another learner’s reply. General bot replies remain visible to the group, while history exports and analytics are sent only to the requesting member’s private chat.
- 🛡️ **Verified uploads** — PDF, PPTX, JPG, PNG, and WebP uploads are checked against their file signatures before parsing or storage, so mislabeled content is rejected safely.
- 🔒 **No user API keys** — only the deployment owner supplies `GROQ_API_KEY` as an environment secret; students use the bot without keys or model commands.

## Circuit component schema

When a circuit diagram is requested, the bot can produce a validated `circuit` JSON block. The component inputs must be supplied in the listed order.

| Component | `type` | Required input order |
|---|---|---|
| Basic logic | `and`, `or`, `xor`, `nand`, `nor`, `xnor` | 2–4 logic inputs |
| Unary logic | `not`, `buffer` | 1 logic input |
| Multiplexer | `mux2` | `I0`, `I1`, `S` |
| Multiplexer | `mux4` | `I0`, `I1`, `I2`, `I3`, `S0`, `S1` |
| Flip-flop | `dff` | `D`, `CLK` |
| Flip-flop | `jkff` | `J`, `K`, `CLK` |
| Flip-flop | `tff` | `T`, `CLK` |
| Flip-flop | `srff` | `S`, `R`, `CLK` |
| Decoder | `dec2_4` | `A1`, `A0`, `EN` → one named output bus |
| Decoder | `dec3_8` | `A2`, `A1`, `A0`, `EN` → one named output bus |
| Encoder | `enc4_2` | `D0`, `D1`, `D2`, `D3` → one named output bus |
| Encoder | `enc8_3` | `D0` through `D7` → one named output bus |
| Register | `reg` | `D_bus`, `CLK` with a `bits` integer from 2–32 → one named output bus |

Each component produces one named output. Use identifiers such as `Ybus`, `Dbus`, and `Qbus` for multi-bit signals. Sequential components use `Q` as the recommended single-bit output name; complementary outputs, individual bus-bit breakout, and timing waveforms are not yet modeled.

## Commands

| Command | Description |
| --- | --- |
| `/start` | Start the bot |
| `/help` | Show help message |
| `/sources` | List uploaded sources with their stable removal numbers |
| `/remove <number>` | Delete one source from the `/sources` list and reset any active quiz |
| `/quiz [topic]` | Create one source-grounded multiple-choice practice question; reply with A–D to answer |
| `/quiz source <number> [topic]` | Create a quiz from one numbered PDF/PPTX in `/sources`, preserving its original source number in citations |
| `/flashcards [topic]` | Create five source-grounded study cards |
| `/flashcards source <number> [topic]` | Create flashcards from one numbered PDF/PPTX in `/sources`, preserving its original source number in citations |
| `/studyguide [topic]` | Create a source-cited exam revision guide with five high-yield points, three exam tips, and a three-step study plan |
| `/studyguide source <number> [topic]` | Create a revision guide from one numbered PDF/PPTX in `/sources`, preserving its original source number in citations |
| `/analytics` | Show private quiz accuracy and recommended study focus; in groups, delivered to the requester’s private chat |
| `/limits` | Show the workspace’s remaining study-request capacity without using a request |
| `/export` | Download your recent chat history as a text file; in groups, delivered to the requester’s private chat |
| `/cancel` | Cancel the active quiz while keeping uploaded sources |
| `/rethink` | Re-answer your last question |
| `/clear` | Confirm before deleting your sources, conversation memory, and quiz state |

## Local Setup

```bash
cp .env.example .env   # add TELEGRAM_BOT_TOKEN and GROQ_API_KEY
npm install
npm start
```

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from [@BotFather](https://t.me/BotFather) |
| `GROQ_API_KEY` | Yes | Owner-managed Groq deployment secret; never expose or request it from students |
| `PORT` | No | HTTP port for the health server (default `8080`) |
| `TAVILY_API_KEY` | No | Used for web search if Firecrawl isn't set |
| `FIRECRAWL_API_KEY` | No | If set, web search uses Firecrawl (search + scrapes the top 2 pages for real content) |
| `ANSWER_MODEL` | No | Owner-selected text reasoning model (default `openai/gpt-oss-120b`) |
| `VISION_MODEL` | No | Owner-selected vision model for full-page detection (default `qwen/qwen3.6-27b`) |
| `ANSWER_TEMPERATURE` | No | Answer determinism setting (default `0.15`) |
| `MAX_COMPLETION_TOKENS` | No | Maximum answer length from the text model (default `4096`) |
| `MAX_SOURCE_CHARS` | No | Max chars of lecture sources sent to the model (default `20000`) |
| `MAX_UPLOAD_BYTES` | No | Maximum accepted PDF/PPTX upload size in bytes (default `12582912`, or 12 MB) |
| `MAX_IMAGE_BYTES` | No | Maximum accepted JPG/PNG/WebP image size in bytes, including forwarded photos (default `6291456`, or 6 MB) |
| `MAX_TEXT_QUESTION_CHARS` | No | Maximum text-question or quiz-topic length (default `6000`) |
| `MAX_SOURCES_PER_CHAT` | No | Maximum PDF/PPTX/image sources stored for one chat (default `12`) |
| `MAX_SCANNED_PDF_PAGES` | No | Maximum image-only PDF pages processed with vision fallback (default `15`) |
| `PDF_RENDER_DPI` | No | Rasterization quality for scanned PDF detection (default `160`) |
| `REQUEST_TIMEOUT_MS` | No | Maximum wait for Telegram, model, and search requests before returning a clear error (default `60000`) |
| `MAX_MODEL_REQUESTS_PER_WINDOW` | No | Maximum model calls accepted per learner workspace in the rolling request window, including each vision batch (default `12`) |
| `MODEL_REQUEST_WINDOW_SECONDS` | No | Duration of the rolling model-request window in seconds (default `60`) |
| `HF_RETRIEVAL_ENABLED` | No | Enables semantic source reranking (default `true`) |
| `HF_TOKEN` | No | Owner-managed Hugging Face token with Inference Providers permission; keep it secret. When absent or unavailable, the bot uses local fuzzy source matching by default. |
| `HF_EMBEDDING_MODEL` | No | Hugging Face feature-extraction model used for source reranking (default `thenlper/gte-large`) |
| `HF_INFERENCE_PROVIDER` | No | Hugging Face Inference Provider used for embeddings (default `hf-inference`) |
| `FUZZY_RETRIEVAL_FALLBACK_ENABLED` | No | Enables local typo-tolerant source matching when remote embeddings are unavailable (default `true`); set `false` for lexical-only fallback. |
| `SOURCES_FILE` | No | Optional path for persisted uploaded sources (defaults to `/data/sources.json` where available) |
| `QUIZ_PERFORMANCE_FILE` | No | Optional path for private persisted quiz analytics, isolated by learner workspace (defaults to `/data/quiz-performance.json` where available) |
| `UPDATE_OFFSET_FILE` | No | Optional path for the persisted Telegram update checkpoint, preventing already-seen updates from being reprocessed after a restart (defaults to `/data/update-offset.json` where available) |

## Docker

```bash
docker build -t exambuddybot .
docker run -d --env-file .env -e PORT=8080 -p 8080:8080 exambuddybot
```

The container exposes a health endpoint on `PORT` (returns `ok`) so Railway marks the service as healthy. Uploaded-source writes and the Telegram update checkpoint are performed atomically, reducing the risk of partial state after an interrupted save and preventing already-seen updates from being reprocessed after a restart. Source libraries use stable workspace keys, preserving private-chat compatibility while isolating each group participant’s data. Each workspace also receives a configurable rolling model-request budget before a model call begins; vision batches consume one slot each, preventing a single burst from exhausting shared deployment capacity. If `HF_TOKEN` is configured, the bot first calls Hugging Face Inference Providers for semantic source retrieval; when no token is configured or the remote provider fails, it uses local typo-tolerant matching without an additional dependency or external source-text request.

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → select the repo.
3. **Variables**: add `TELEGRAM_BOT_TOKEN` and `GROQ_API_KEY` (`.env` is gitignored and not committed).
4. Deploy and message the bot to confirm.

> ⚠️ The bot uses long-polling, so only one instance may run at a time. Stop any local instance before Railway comes up, or you'll get 409 conflict errors.
