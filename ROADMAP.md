# Roadmap

Planned work for the investment system. Status of the current build is at the bottom.

---

## 1. Free multi-provider LLM for the AI summaries

**Why.** The two AI features — **IPO brief** (`ipo-brief`) and **News digest** (`news-digest`) — currently call the paid Anthropic API (`api.anthropic.com`, hardcoded model `claude-sonnet-4-6`, which is also a stale id). Groq, Cerebras, Google Gemini and Mistral all offer **free tiers** and an **OpenAI-compatible** chat-completions API, so we can drive the same summaries for free and let the user pick a provider by which key they set.

**Design.**
- New shared helper `supabase/functions/_shared/llm.ts` exposing `chatCompletion({ system, user, maxTokens, json? }) => string`.
- Provider + model + endpoint resolved from env. **Auto-detect** by first key present (override with `LLM_PROVIDER`):

  | Provider | Endpoint (OpenAI-compatible) | Key env | Example model |
  |---|---|---|---|
  | Groq | `https://api.groq.com/openai/v1/chat/completions` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
  | Cerebras | `https://api.cerebras.ai/v1/chat/completions` | `CEREBRAS_API_KEY` | `llama-3.3-70b` |
  | Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `GEMINI_API_KEY` | `gemini-2.0-flash` |
  | Mistral | `https://api.mistral.ai/v1/chat/completions` | `MISTRAL_API_KEY` | `mistral-small-latest` |
  | Anthropic (fallback) | `https://api.anthropic.com/v1/messages` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |

- All four free providers take `{ model, messages:[{role:'system'|'user',...}], max_tokens }` and return `choices[0].message.content`. The helper converts the existing Anthropic-style `system` parameter into a leading system message; the Anthropic branch keeps the native `/v1/messages` shape.
- `news-digest` expects **structured JSON** back and parses it. Request JSON (OpenAI-compat `response_format: {type:'json_object'}` where supported) and parse defensively. Use a capable model (llama-3.3-70b class) for reliable JSON.

**Files.** `supabase/functions/_shared/llm.ts` (new), `ipo-brief/index.ts`, `news-digest/index.ts`, `.github/workflows/supabase-deploy.yml` (pass the provider keys through to `supabase secrets set`), README note.

**Secrets to add (GitHub → Actions).** One of `GROQ_API_KEY` / `CEREBRAS_API_KEY` / `GEMINI_API_KEY` / `MISTRAL_API_KEY` (+ optional `LLM_PROVIDER`).

**Open questions.**
- Default provider order when several keys are set (proposed: Groq → Cerebras → Gemini → Mistral → Anthropic).
- JSON reliability of `news-digest` on smaller free models — may pin to a 70B-class model.

**Effort:** M. No frontend change.

---

## 2. Bitvavo live crypto integration

**Why.** Hold crypto on Bitvavo. Pull balances into `holdings` automatically and price them live in EUR, so crypto shows up in the portfolio/allocation alongside the stocks.

**Design.**
- **Pricing** — extend `refresh-prices` to price crypto. Route `<COIN>-EUR` tickers to Bitvavo's **public** ticker API (keyless, EUR-native):
  - price: `GET https://api.bitvavo.com/v2/ticker/price?market=BTC-EUR`
  - 24h change: `GET https://api.bitvavo.com/v2/ticker/24h?market=BTC-EUR`
- **Sync function** — new `supabase/functions/bitvavo-sync`:
  - Auth: HMAC-SHA256 over `timestamp + "GET" + "/v2/balance" + body` with the API secret; headers `Bitvavo-Access-Key`, `Bitvavo-Access-Signature`, `Bitvavo-Access-Timestamp`, `Bitvavo-Access-Window`.
  - `GET /v2/balance` → `[{ symbol, available, inOrder }]`. For each non-EUR balance with amount > 0, upsert a holding: `ticker = <symbol>-EUR`, `currency = EUR`, `shares = available + inOrder`, `bucket = Crypto`.
  - **Cost basis:** `/v2/balance` has no average price. MVP: set `entry_price` to the current price on first sync (P/L starts ~0) and only update `shares` on later syncs. Later: derive true cost basis from `GET /v2/trades?market=…`.
- **Bucket** — crypto doesn't fit the equity buckets. Preferred: add a first-class **`Crypto`** bucket (not pillar-scored, like Bonds/Real-Assets) — touches `types.ts` (`Bucket`), `defaults.ts` (label/desc/color/targets/weights/trail_stops/`ASSET_CLASSES`), `Rules.tsx`, and `auto-score` weights. Quicker alternative: map crypto to `Real-Assets` or `Speculative` (no type change).
- **UI** — a **"Sync Bitvavo"** button on the Portfolio page (invokes `bitvavo-sync`); optional daily cron `invsys-bitvavo`.
- **Secrets to add (GitHub → Actions).** `BITVAVO_API_KEY`, `BITVAVO_API_SECRET` — a **read-only** Bitvavo API key (no trading/withdrawal rights). Passed through the deploy workflow to Supabase secrets.

**Open questions.**
- Bucket: dedicated `Crypto` bucket (recommended) vs map to an existing one.
- Cost basis: current-price-on-first-sync (MVP) vs compute from trade history.
- Sync cadence: manual button only, or also a daily cron.

**Effort:** L. Requires the user's read-only Bitvavo API key + secret.

---

## Done (live today)

- Frontend on Cloudflare Pages; Supabase backend provisioned entirely from CI (`Supabase deploy` workflow: migrations + secrets + all Edge Functions + pg_cron jobs).
- DB schema reconstructed (migrations `0001`–`0005`); scores fixed for European listings (TradingView fundamentals for `.DE`/`.PA`/`.AS`); cron-capable `auto-score`.
- DeGiro CSV import on the Transactions page.
- Seed portfolio emptied; the user's real holdings loaded.
- Web Push notifications (rule-breach / stop / buy-target digest) — verified delivering.
- Ops workflows: `test-alerts`, `fill-universe`.
