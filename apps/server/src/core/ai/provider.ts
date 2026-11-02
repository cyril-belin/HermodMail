import type { DB } from '../../db/database.js'
import { AppError } from '../errors.js'
import { decryptSecret, encryptSecret } from '../crypto.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiProvider {
  readonly name: string
  readonly model: string
  chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>
}

export type AiProviderKind = 'none' | 'ollama' | 'openai'

export interface AiSettings {
  provider: AiProviderKind
  baseUrl: string
  model: string
  systemHint: string
}

interface AiSettingsRow {
  id: number
  provider: string
  base_url: string
  model: string
  api_key_enc: string
  system_hint: string
  updated_at: number
}

export class AiProviderRegistry {
  constructor(
    private readonly db: DB,
    private readonly masterSecret: Buffer,
  ) {}

  getSettings(): AiSettings {
    const row = this.db.prepare('SELECT * FROM ai_settings WHERE id = 1').get() as AiSettingsRow | undefined
    if (!row) return { provider: 'none', baseUrl: '', model: '', systemHint: '' }
    return { provider: row.provider as AiProviderKind, baseUrl: row.base_url, model: row.model, systemHint: row.system_hint }
  }

  setSettings(input: { provider: AiProviderKind; baseUrl?: string; model?: string; apiKey?: string; systemHint?: string }): AiSettings {
    const row = this.db.prepare('SELECT * FROM ai_settings WHERE id = 1').get() as AiSettingsRow | undefined
    const apiKeyEnc = input.apiKey !== undefined ? (input.apiKey ? encryptSecret(input.apiKey, this.masterSecret) : '') : (row?.api_key_enc ?? '')
    this.db
      .prepare('UPDATE ai_settings SET provider=?, base_url=?, model=?, api_key_enc=?, system_hint=?, updated_at=? WHERE id=1')
      .run(input.provider, (input.baseUrl ?? row?.base_url ?? '').trim(), (input.model ?? row?.model ?? '').trim(), apiKeyEnc, input.systemHint ?? row?.system_hint ?? '', Date.now())
    return this.getSettings()
  }

  /** Build the active provider from current settings. Throws 503 when not configured. */
  getActiveProvider(): AiProvider {
    const s = this.getSettings()
    if (s.provider === 'none' || !s.model) {
      throw new AppError('ai_unavailable', 'AI is not configured. An administrator can configure it in Settings → AI.')
    }
    const row = this.db.prepare('SELECT api_key_enc FROM ai_settings WHERE id = 1').get() as { api_key_enc: string } | undefined
    const apiKey = row?.api_key_enc ? decryptSecret(row.api_key_enc, this.masterSecret) : ''
    if (s.provider === 'ollama') {
      const base = s.baseUrl || 'http://127.0.0.1:11434'
      return new OllamaProvider(base, s.model)
    }
    const base = s.baseUrl || 'https://api.openai.com/v1'
    if (!apiKey) throw new AppError('ai_unavailable', 'AI provider "openai-compatible" requires an API key')
    return new OpenAiCompatProvider(base, s.model, apiKey)
  }

  async testProvider(): Promise<{ ok: true; reply: string }> {
    const provider = this.getActiveProvider()
    const reply = await provider.chat([{ role: 'user', content: 'Reply with the single word: ready' }], { maxTokens: 10 })
    return { ok: true, reply: reply.trim().slice(0, 80) }
  }
}

/** Local Ollama (no paid dependency). */
export class OllamaProvider implements AiProvider {
  constructor(
    readonly baseUrl: string,
    readonly model: string,
  ) {}
  get name() {
    return 'ollama'
  }
  async chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
    // Relative path on purpose: a leading '/' would reset to the domain root
    // and drop the base's own path (e.g. a reverse-proxied /ollama prefix).
    const res = await fetch(new URL('api/chat', this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        options: { temperature: opts?.temperature ?? 0.3, num_predict: opts?.maxTokens ?? 1024 },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new AppError('ai_unavailable', `Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { message?: { content?: string } }
    return json.message?.content ?? ''
  }
}

/** OpenAI-compatible chat completions (OpenAI, Groq, OpenRouter, vLLM, llama.cpp server…). */
export class OpenAiCompatProvider implements AiProvider {
  constructor(
    readonly baseUrl: string,
    readonly model: string,
    private readonly apiKey: string,
  ) {}
  get name() {
    return 'openai'
  }
  async chat(messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string> {
    // Relative path on purpose: a leading '/' resets to the domain root and
    // drops the base's path — Gemini's OpenAI-compat base
    // (…/v1beta/openai) landed on https://host/chat/completions → 404.
    const res = await fetch(new URL('chat/completions', this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts?.temperature ?? 0.3,
        max_tokens: opts?.maxTokens ?? 1024,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new AppError('ai_unavailable', `AI provider error ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return json.choices?.[0]?.message?.content ?? ''
  }
}
