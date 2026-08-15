# ExamBuddyBot

Telegram bot that answers exam questions from forwarded images, uploaded sources (PDFs/images), or web search. The deployment owner configures the model credentials once; students never need to provide API keys. It uses GPT-OSS 120B for high-quality text reasoning and Qwen 3.6 27B for vision-based page detection.

## Features

- 📷 **Forward images or albums** (question papers, homework, notes) — pages are processed in order, with every readable question, option, formula, table, and circuit detected.
- 📄 **Send a PDF or PPTX** — text PDFs/PPTX files are saved as cited lecture sources; image-only PDFs automatically fall back to full-page vision detection in bounded batches.
- ✍️ **Send a text question** — answered from your uploaded sources, or from the web (Firecrawl / Tavily / DuckDuckGo).
- 📝 **Source-grounded quizzes** — use `/quiz [topic]` to generate one validated multiple-choice practice question from uploaded PDF/PPTX sources, then reply with A–D for immediate feedback.
- 📖 **Hybrid source retrieval** — answers combine lexical matching with optional Hugging Face semantic embeddings, improving selection of relevant source passages while preserving a safe lexical fallback.
- ⚙️ **Validated circuit diagrams** — for supported combinational logic-gate questions, the bot validates every signal and dependency before drawing clean gate symbols and wires. It supports one-input NOT/buffer gates and two- through four-input basic combinational gates. Unsupported sequential/timing circuits receive an explanation rather than an incorrect diagram.
- 💬 **Conversation memory** — remembers recent Q&A so follow-up questions have context.
- 🔒 **No user API keys** — only the deployment owner supplies `GROQ_API_KEY` as an environment secret; students use the bot without keys or model commands.

## Commands

| Command | Description |
| --- | --- |
| `/start` | Start the bot |
| `/help` | Show help message |
| `/sources` | List your uploaded PDF/PPTX/image sources |
| `/quiz [topic]` | Create one source-grounded multiple-choice practice question; reply with A–D to answer |
| `/rethink` | Re-answer your last question |
| `/clear` | Delete your sources and conversation memory |

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
| `MAX_UPLOAD_BYTES` | No | Maximum accepted upload size in bytes (default `12582912`, or 12 MB) |
| `MAX_SOURCES_PER_CHAT` | No | Maximum PDF/PPTX/image sources stored for one chat (default `12`) |
| `MAX_SCANNED_PDF_PAGES` | No | Maximum image-only PDF pages processed with vision fallback (default `15`) |
| `PDF_RENDER_DPI` | No | Rasterization quality for scanned PDF detection (default `160`) |
| `HF_RETRIEVAL_ENABLED` | No | Enables semantic source reranking when an owner token is available (default `true`) |
| `HF_TOKEN` | No | Owner-managed Hugging Face token with Inference Providers permission; keep it secret. Without it, lexical retrieval remains active. |
| `HF_EMBEDDING_MODEL` | No | Hugging Face feature-extraction model used for source reranking (default `thenlper/gte-large`) |
| `HF_INFERENCE_PROVIDER` | No | Hugging Face Inference Provider used for embeddings (default `hf-inference`) |
| `SOURCES_FILE` | No | Optional path for persisted uploaded sources (defaults to `/data/sources.json` where available) |

## Docker

```bash
docker build -t exambuddybot .
docker run -d --env-file .env -e PORT=8080 -p 8080:8080 exambuddybot
```

The container exposes a health endpoint on `PORT` (returns `ok`) so Railway marks the service as healthy. If `HF_TOKEN` is configured, the bot calls Hugging Face Inference Providers for semantic source retrieval; otherwise it automatically continues with lexical retrieval.

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → select the repo.
3. **Variables**: add `TELEGRAM_BOT_TOKEN` and `GROQ_API_KEY` (`.env` is gitignored and not committed).
4. Deploy and message the bot to confirm.

> ⚠️ The bot uses long-polling, so only one instance may run at a time. Stop any local instance before Railway comes up, or you'll get 409 conflict errors.
