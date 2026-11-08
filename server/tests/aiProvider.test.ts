/**
 * tests/aiProvider.test.ts
 *
 * Automated unit tests for GeminiProvider and AIExtractor.service (mocked HTTP / provider).
 * Separated from live Gemini API tests.
 *
 * Covers:
 *  1. Genuine provider response parsing (valid structured JSON).
 *  2. Invalid JSON response -> AI_INVALID_RESPONSE.
 *  3. Missing required top-level fields -> AI_INVALID_RESPONSE.
 *  4. Unknown fields rejected by strict Zod schema.
 *  5. Cost-related field rejection -> AI_COST_FIELD_REJECTED.
 *  6. Missing API key -> AI_NOT_CONFIGURED.
 *  7. Provider unavailable (HTTP 500 / network error) -> AI_UNAVAILABLE.
 *  8. Timeout handling (AbortError) -> AI_TIMEOUT.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeminiProvider } from '../src/services/ai/GeminiProvider';
import { AIError, type AIProvider } from '../src/services/ai/AIProvider';
import {
  extractFromEmail,
  assertNoCostFields,
} from '../src/services/ai/AIExtractor.service';

describe('GeminiProvider (mocked fetch)', () => {
  it('parses a valid Gemini generateContent response', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    rfq: {
                      rfqNo: {
                        value: 'RFQ-2611-900',
                        snippet: 'RFQ No: RFQ-2611-900',
                        confidence: 0.98,
                      },
                      customer: {
                        value: 'Synthetic Motors Pvt Ltd',
                        snippet: 'From: Synthetic Motors Pvt Ltd',
                        confidence: 0.95,
                      },
                    },
                    parts: [
                      {
                        partName: {
                          value: 'Input Pinion Shaft',
                          snippet: 'Part: Input Pinion Shaft',
                        },
                        material: {
                          value: 'EN8',
                          snippet: 'Material: EN8',
                        },
                        grossWeightKg: {
                          value: 0.85,
                          snippet: 'Gross Weight: 0.85 kg',
                        },
                        annualVolume: {
                          value: 25000,
                          snippet: 'Annual Volume: 25,000 pcs/year',
                        },
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });

    const provider = new GeminiProvider({
      apiKey: 'test-synthetic-key',
      model: 'gemini-3.8-flash',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    const emailText = [
      'From: Synthetic Motors Pvt Ltd',
      'RFQ No: RFQ-2611-900',
      'Part: Input Pinion Shaft',
      'Material: EN8',
      'Gross Weight: 0.85 kg',
      'Annual Volume: 25,000 pcs/year',
    ].join('\n');

    const result = await extractFromEmail(emailText, provider);
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-3.8-flash');
    expect(result.rfq.rfqNo.value).toBe('RFQ-2611-900');
    expect(result.rfq.rfqNo.verified).toBe(true);
    expect(result.rfq.customer.value).toBe('Synthetic Motors Pvt Ltd');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].partName.value).toBe('Input Pinion Shaft');
    expect(result.parts[0].material.value).toBe('EN8');
    expect(result.parts[0].grossWeightKg.value).toBe(0.85);
    expect(result.parts[0].annualVolume.value).toBe(25000);
    expect(result.parts[0].annualVolume.verified).toBe(true);
  });

  it('throws AI_NOT_CONFIGURED when API key is missing', async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const provider = new GeminiProvider({ apiKey: '' });
      expect(provider.isConfigured()).toBe(false);
      await expect(
        provider.generateJson({ systemInstruction: 'sys', userContent: 'user' }),
      ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    }
  });

  it('throws AI_UNAVAILABLE when provider returns HTTP 500 or network error', async () => {
    const fakeFetch500 = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Internal failure' } }),
    });
    const provider500 = new GeminiProvider({
      apiKey: 'test-key',
      maxAttempts: 1,
      fetchImpl: fakeFetch500 as unknown as typeof fetch,
    });
    await expect(
      provider500.generateJson({ systemInstruction: 'sys', userContent: 'user' }),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });

    const fakeFetchNet = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const providerNet = new GeminiProvider({
      apiKey: 'test-key',
      maxAttempts: 1,
      fetchImpl: fakeFetchNet as unknown as typeof fetch,
    });
    await expect(
      providerNet.generateJson({ systemInstruction: 'sys', userContent: 'user' }),
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('throws AI_TIMEOUT when request exceeds timeoutMs', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const fakeFetchTimeout = vi.fn().mockRejectedValue(abortErr);

    const provider = new GeminiProvider({
      apiKey: 'test-key',
      timeoutMs: 50,
      maxAttempts: 1,
      fetchImpl: fakeFetchTimeout as unknown as typeof fetch,
    });

    await expect(
      provider.generateJson({ systemInstruction: 'sys', userContent: 'user' }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });
});

describe('AIExtractor schema & cost-field guards (mocked AIProvider)', () => {
  function mockProviderReturning(rawText: string): AIProvider {
    return {
      providerName: 'mock-test',
      modelName: 'mock-model',
      generateJson: vi.fn().mockResolvedValue(rawText),
    };
  }

  it('rejects invalid JSON responses with AI_INVALID_RESPONSE', async () => {
    const provider = mockProviderReturning('not-valid-json {{{');
    await expect(
      extractFromEmail('Sample RFQ email content here', provider),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('rejects responses missing required top-level keys (rfq / parts)', async () => {
    const provider = mockProviderReturning(JSON.stringify({ rfq: {} }));
    await expect(
      extractFromEmail('Sample RFQ email content here', provider),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('rejects unknown fields via strict Zod schema', async () => {
    const provider = mockProviderReturning(
      JSON.stringify({
        rfq: {
          rfqNo: { value: 'RFQ-1' },
          unexpectedField: { value: 'bad' },
        },
        parts: [],
      }),
    );
    await expect(
      extractFromEmail('Sample RFQ email content here', provider),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
  });

  it('rejects cost-related fields anywhere in AI output with AI_COST_FIELD_REJECTED', async () => {
    const forbiddenPayloads = [
      { rfq: {}, parts: [{ partName: { value: 'Shaft' }, materialCost: { value: 45 } }] },
      { rfq: {}, parts: [{ sellingPriceExGst: 120 }] },
      { rfq: { marginPct: 15 }, parts: [] },
      { rfq: {}, parts: [{ machineHourRate: 850 }] },
      { rfq: {}, parts: [{ cycleTimeMinutes: 3.2 }] },
    ];

    for (const payload of forbiddenPayloads) {
      expect(() => assertNoCostFields(payload)).toThrowError(AIError);
      const provider = mockProviderReturning(JSON.stringify(payload));
      await expect(
        extractFromEmail('Sample RFQ email content here', provider),
      ).rejects.toMatchObject({ code: 'AI_COST_FIELD_REJECTED' });
    }
  });
});

