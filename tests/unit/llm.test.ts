import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/domain/contracts';
import { estimateCostMicrousd } from '../../src/llm/budget';
import { createLlmProvider } from '../../src/llm/provider';

function config(overrides: Partial<AppConfig['llm']> = {}): AppConfig {
  return {
    profileId: 'personal', timezone: 'Asia/Shanghai',
    schedule: { morning: '07:45', cutoff: '08:00', buildDeadline: '08:25', send: '08:30', close: '09:00' },
    limits: { maxSources: 20, maxPages: 3, pageSize: 30, maxNewBodiesPerRun: 20, fetchTimeoutMs: 10_000, llmTimeoutMs: 30_000, maxResponseBytes: 2_000_000, maxBodyBytes: 128_000, maxModelCharsPerArticle: 12_000, maxCandidates: 200, maxDeepRead: 20, maxEvents: 8, perInstanceConcurrency: 2, maxAttemptsPerStage: 3, maxRepairAttempts: 1 },
    editorial: { targetMinChars: 600, targetMaxChars: 1200, historyDays: 30, lateHours: 48, initialHours: 48, threshold: 60 },
    llm: { baseUrl: 'https://llm.example.com/v1', model: 'model-a', promptVersion: 'v1', jsonMode: 'json_object', maxOutputTokens: 500, tokenizer: 'conservative_utf8', inputMicrousdPerMillionTokens: 1_000_000, outputMicrousdPerMillionTokens: 2_000_000, pricingIncludesAllBillableTokens: true, ...overrides },
    budget: { dayMicrousd: 750_000, monthMicrousd: 15_000_000 },
    delivery: { channel: 'dummy', destinationConfigRef: 'dummy' },
  };
}

describe('LLM cost and provider', () => {
  it('uses micro-USD and rounds up once', () => {
    expect(estimateCostMicrousd(1000, 500, 1_000_000, 2_000_000)).toBe(2000);
    expect(estimateCostMicrousd(1, 0, 1, 1)).toBe(1);
  });

  it('rejects unsafe integer inputs', () => {
    expect(() => estimateCostMicrousd(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, 1)).toThrow('COST_OVERFLOW');
    expect(() => estimateCostMicrousd(-1, 0, 1, 1)).toThrow('COST_INVALID');
  });

  it('forbids a real request when pricing is missing', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createLlmProvider(config({ inputMicrousdPerMillionTokens: null }), 'secret', fetcher);
    await expect(provider.complete({ stage: 'filter', digestId: 'd', input: {}, maxOutputTokens: 10 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PRICING_MISSING', kind: 'permanent' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('forbids a real request until the configured prices cover every billable token', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createLlmProvider(config({ pricingIncludesAllBillableTokens: false }), 'secret', fetcher);
    await expect(provider.complete({ stage: 'filter', digestId: 'd', input: {}, maxOutputTokens: 10 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'BILLING_SCOPE_UNVERIFIED', kind: 'permanent' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does one HTTP attempt and classifies a throttled response as retryable', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"busy"}', { status: 429, headers: { 'retry-after': '2' } }));
    const provider = createLlmProvider(config(), 'secret', fetcher);
    await expect(provider.complete({ stage: 'edit', digestId: 'd', input: { prompt: 'x' }, maxOutputTokens: 20 }, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: 'HTTP_429', kind: 'retryable', retryAfterMs: 2000 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('explicitly disables thinking for a configured DeepSeek JSON request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'request-deepseek', choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    })));
    const provider = createLlmProvider(config({ thinking: 'disabled' }), 'secret', fetcher);
    const result = await provider.complete({ stage: 'filter', digestId: 'd', input: {}, maxOutputTokens: 64 }, new AbortController().signal);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it('rejects an oversized successful response before buffering all of it', async () => {
    const bounded = config();
    bounded.limits.maxResponseBytes = 64;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'request-too-large', choices: [{ message: { content: JSON.stringify({ value: 'x'.repeat(128) }) } }],
    }), { headers: { 'content-type': 'application/json' } }));
    const provider = createLlmProvider(bounded, 'secret', fetcher);

    await expect(provider.complete(
      { stage: 'filter', digestId: 'd', input: {}, maxOutputTokens: 10 },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', kind: 'uncertain' });
  });

  it('sends the declared output contract in both the prompt and native json-schema mode', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'request-1', choices: [{ message: { content: '{"results":[]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } }));
    const provider = createLlmProvider(config({ jsonMode: 'json_schema' }), 'secret', fetcher);
    await provider.complete({ stage: 'filter', digestId: 'd', input: {
      system: 'Follow the contract.', outputSchema: { type: 'object', properties: { results: { type: 'array' } }, required: ['results'] }, payload: { candidates: [] },
    }, maxOutputTokens: 20 }, new AbortController().signal);
    const init = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; response_format: { type: string; json_schema: { schema: unknown } } };
    expect(JSON.parse(body.messages[1]!.content)).toHaveProperty('outputSchema');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema).toHaveProperty('properties.results');
    expect(body).not.toHaveProperty('thinking');
  });
});
