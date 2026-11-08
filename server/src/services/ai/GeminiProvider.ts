/**
 * services/ai/GeminiProvider.ts
 *
 * Google Gemini Developer API provider (REST, no SDK).
 * - Reads GEMINI_API_KEY / AI_MODEL lazily from the environment, so the app starts
 *   without a key; a request without one fails with AI_NOT_CONFIGURED.
 * - The key is sent only in the x-goog-api-key header and is never logged or returned.
 * - Retries transient 429/503 with backoff; enforces a request timeout.
 *
 * PRIVACY: free-tier Gemini terms allow submitted content to be used to improve Google
 * products. Use synthetic documents only. This does NOT meet a no-training requirement.
 */

import dotenv from 'dotenv';
import { AIError, type AIGenerateJsonRequest, type AIProvider, type AIStatus } from './AIProvider';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_DATA_POLICY_NOTICE =
  'Free-tier Gemini may use submitted content to improve Google products. ' +
  'Use synthetic documents only — do not submit real customer or NDA-protected data.';

export interface GeminiOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class GeminiProvider implements AIProvider {
  readonly providerName = 'gemini';
  private readonly apiKey: string | undefined;
  readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiOptions = {}) {
    if (opts.apiKey === undefined && !process.env.GEMINI_API_KEY) {
      dotenv.config();
    }
    this.apiKey = (opts.apiKey ?? process.env.GEMINI_API_KEY ?? '').trim().replace(/^["']|["']$/g, '') || undefined;
    this.modelName = (opts.model ?? process.env.AI_MODEL ?? DEFAULT_MODEL).trim();
    this.timeoutMs = opts.timeoutMs ?? 25_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 1500;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  status(): AIStatus {
    return {
      configured: this.isConfigured(),
      provider: this.providerName,
      model: this.modelName,
      dataPolicyNotice: GEMINI_DATA_POLICY_NOTICE,
    };
  }

  async generateJson(req: AIGenerateJsonRequest): Promise<string> {
    if (!this.apiKey) {
      throw new AIError(
        'AI_NOT_CONFIGURED',
        'AI extraction is not configured: GEMINI_API_KEY is not set on the server.',
      );
    }

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: req.systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: req.userContent }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });

    const candidateModels = [
      this.modelName,
      ...FALLBACK_MODELS.filter((m) => m !== this.modelName),
    ];

    let lastErr: AIError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const activeModel = candidateModels[(attempt - 1) % candidateModels.length];
      const url = `${API_BASE}/models/${encodeURIComponent(activeModel)}:generateContent`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body,
          signal: ctrl.signal,
        });

        if (res.ok) {
          const json = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
          if (!text) throw new AIError('AI_INVALID_RESPONSE', 'Model returned an empty response.');
          return text;
        }

        // Never include the response body verbatim in logs; surface only a short status message.
        if (res.status === 429 || res.status === 503) {
          lastErr = new AIError(
            res.status === 429 ? 'AI_RATE_LIMITED' : 'AI_UNAVAILABLE',
            `AI provider is busy or rate limited (HTTP ${res.status}).`,
          );
          if (attempt < this.maxAttempts) {
            await sleep(this.retryBaseMs * attempt);
            continue;
          }
          throw lastErr;
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          throw new AIError('AI_NOT_CONFIGURED', `AI provider rejected the request or credentials (HTTP ${res.status}).`);
        }
        if (res.status === 404) {
          throw new AIError('AI_NOT_CONFIGURED', `Configured AI model "${this.modelName}" is not available (HTTP 404).`);
        }
        throw new AIError('AI_UNAVAILABLE', `AI provider error (HTTP ${res.status}).`);
      } catch (e) {
        if (e instanceof AIError) {
          if (e.code === 'AI_RATE_LIMITED' || e.code === 'AI_UNAVAILABLE') {
            lastErr = e;
            if (attempt < this.maxAttempts && lastErr === e && !String(e.message).includes('provider error')) continue;
          }
          throw e;
        }
        if ((e as Error).name === 'AbortError') {
          lastErr = new AIError('AI_TIMEOUT', `AI request timed out after ${this.timeoutMs} ms.`);
          if (attempt < this.maxAttempts) continue;
          throw lastErr;
        }
        throw new AIError('AI_UNAVAILABLE', 'AI provider is unreachable.');
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new AIError('AI_UNAVAILABLE', 'AI provider is unavailable.');
  }
}

/** Provider factory — the only place that knows which provider is active. */
export function getAIProvider(): GeminiProvider {
  return new GeminiProvider();
}

