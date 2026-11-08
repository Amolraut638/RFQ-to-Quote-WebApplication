/**
 * services/ai/AIProvider.ts
 *
 * Provider-neutral contract for genuine LLM inference.
 * Implementations MUST perform real model inference — no canned or rule-based output.
 * Swap the implementation (see getAIProvider) to move to a provider under an
 * enterprise no-training agreement.
 */

export type AIErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_RATE_LIMITED'
  | 'AI_INVALID_RESPONSE'
  | 'AI_COST_FIELD_REJECTED';

export class AIError extends Error {
  constructor(public readonly code: AIErrorCode, message: string) {
    super(message);
    this.name = 'AIError';
  }
}

export interface AIGenerateJsonRequest {
  /** Trusted instructions (never contains document content). */
  systemInstruction: string;
  /** Untrusted document content, clearly delimited by the caller. */
  userContent: string;
}

export interface AIProvider {
  readonly providerName: string;
  readonly modelName: string;
  /** Returns the raw JSON text produced by the model. Callers validate with Zod. */
  generateJson(req: AIGenerateJsonRequest): Promise<string>;
}

export interface AIStatus {
  configured: boolean;
  provider: string;
  model: string | null;
  /** Shown in the UI so users know where document content is sent. */
  dataPolicyNotice: string;
}

