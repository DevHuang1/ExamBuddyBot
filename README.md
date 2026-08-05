# ExamBuddyBot

Telegram bot that answers exam questions from forwarded images, uploaded sources (PDFs/images), or web search. Uses Groq (Llama-3.3-70B for text, Qwen 3.6 27B for vision).

## Features

- 📷 **Forward an image** (question paper, homework, notes) — read and answered directly using a vision model.
- 📄 **Send a PDF or PPTX** — saved as a lecture source (with page/slide numbers) for answering questions.
- ✍️ **Send a text question** — answered from your uploaded sources, or from the web (Firecrawl / Tavily / DuckDuckGo).
- 📖 **Citations + links** — answers cite the source PDF and page number, and include a related web link.
- ⚙️ **Circuit diagrams** — for circuit/diagram questions the bot draws real gate symbols (AND/OR/NOT/XOR/NAND/NOR) with wires and sends the diagram as an image in chat.
- 💬 **Conversation memory** — remembers your recent Q&A so follow-up questions have context.
- 🔑 **Per-user Groq API keys** — optional; falls back to a preconfigured key. Keys persist to `/data/keys.json` (Railway) or local `data/` and can be cleared anytime.
- 🧠 **Custom model** — choose your own Groq text model.

## Commands

| Command | Description |
| --- | --- |
| `/start` | Start the bot |
| `/help` | Show help message |
| `/apikey <key>` | Set your own Groq API key |
| `/resetkey` | Go back to the preconfigured key |
| `/model <name>` | Set your own text model (optional) |
| `/sources` | List your uploaded PDF/PPTX/image sources |
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
| `GROQ_API_KEY` | Yes* | Preconfigured Groq key (*unless all users use `/apikey`) |
| `PORT` | No | HTTP port for the health server (default `8080`) |
| `TAVILY_API_KEY` | No | Used for web search if Firecrawl isn't set |
| `FIRECRAWL_API_KEY` | No | If set, web search uses Firecrawl (search + scrapes the top 2 pages for real content) |
| `MAX_SOURCE_CHARS` | No | Max chars of lecture sources sent to the model (default `20000`, to stay within Groq's free-tier TPM) |

## Docker

```bash
docker build -t exambuddybot .
docker run -d --env-file .env -e PORT=8080 -p 8080:8080 exambuddybot
```

The container exposes a health endpoint on `PORT` (returns `ok`) so Railway marks the service as healthy.

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → select the repo.
3. **Variables**: add `TELEGRAM_BOT_TOKEN` and `GROQ_API_KEY` (`.env` is gitignored and not committed).
4. Deploy and message the bot to confirm.

> ⚠️ The bot uses long-polling, so only one instance may run at a time. Stop any local instance before Railway comes up, or you'll get 409 conflict errors.
