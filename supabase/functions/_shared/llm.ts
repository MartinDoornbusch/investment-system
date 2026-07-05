// Provider-agnostic LLM client for the Edge Functions.
// Free providers (Groq, Cerebras, Gemini, Mistral) all speak the OpenAI /chat/completions format;
// Anthropic uses its own /v1/messages. Pick a provider by setting ONE of the *_API_KEY secrets.
// Override the provider with LLM_PROVIDER and the model with LLM_MODEL (future-proof — you choose
// the exact version without a code change).

type Provider = 'groq' | 'cerebras' | 'gemini' | 'mistral' | 'anthropic'
interface Cfg { keyEnv: string; url: string; defaultModel: string; kind: 'openai' | 'anthropic' }

const PROVIDERS: Record<Provider, Cfg> = {
  groq:      { keyEnv: 'GROQ_API_KEY',      kind: 'openai',    defaultModel: 'llama-3.3-70b-versatile', url: 'https://api.groq.com/openai/v1/chat/completions' },
  cerebras:  { keyEnv: 'CEREBRAS_API_KEY',  kind: 'openai',    defaultModel: 'llama-3.3-70b',           url: 'https://api.cerebras.ai/v1/chat/completions' },
  gemini:    { keyEnv: 'GEMINI_API_KEY',    kind: 'openai',    defaultModel: 'gemini-2.0-flash',        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  mistral:   { keyEnv: 'MISTRAL_API_KEY',   kind: 'openai',    defaultModel: 'mistral-small-latest',    url: 'https://api.mistral.ai/v1/chat/completions' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', kind: 'anthropic', defaultModel: 'claude-sonnet-5',         url: 'https://api.anthropic.com/v1/messages' },
}
// Preference order when several keys are set (free first).
const ORDER: Provider[] = ['groq', 'cerebras', 'gemini', 'mistral', 'anthropic']

function resolve(): { provider: Provider; cfg: Cfg; key: string; model: string } | null {
  const override = (Deno.env.get('LLM_PROVIDER') || '').trim().toLowerCase() as Provider
  const order = override && PROVIDERS[override] ? [override] : ORDER
  for (const p of order) {
    const cfg = PROVIDERS[p]
    const key = Deno.env.get(cfg.keyEnv) || ''
    if (key) return { provider: p, cfg, key, model: (Deno.env.get('LLM_MODEL') || '').trim() || cfg.defaultModel }
  }
  return null
}

export function llmConfigured(): boolean { return resolve() !== null }

/** Chat completion across providers. Returns the text plus which provider/model served it. */
export async function chatCompletion(opts: { system: string; user: string; maxTokens?: number; json?: boolean }): Promise<{ text: string; provider: string; model: string }> {
  const r = resolve()
  if (!r) throw new Error('No LLM key set — set one of GROQ_API_KEY / CEREBRAS_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY / ANTHROPIC_API_KEY')
  const { cfg, key, model, provider } = r
  const maxTokens = opts.maxTokens ?? 1024

  if (cfg.kind === 'anthropic') {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: opts.system, messages: [{ role: 'user', content: opts.user }] }),
    })
    if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    return { text: String((j.content ?? []).map((c: any) => c.text || '').join('')).trim(), provider, model }
  }

  // OpenAI-compatible (Groq / Cerebras / Gemini / Mistral)
  const bodyObj: Record<string, unknown> = {
    model, max_tokens: maxTokens,
    messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
  }
  if (opts.json) bodyObj.response_format = { type: 'json_object' }
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  })
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const j = await res.json()
  return { text: String(j.choices?.[0]?.message?.content ?? '').trim(), provider, model }
}
