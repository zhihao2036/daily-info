import type { AppConfig, LlmProvider, LlmRequest, LlmResponse } from '../domain/contracts';

export function serializeLlmMessages(request: LlmRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const value = request.input;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.system === 'string' && 'payload' in value) {
    return [{ role: 'system', content: value.system }, { role: 'user', content: JSON.stringify({
      outputSchema: value.outputSchema ?? null,
      payload: value.payload,
    }) }];
  }
  return [{ role: 'user', content: JSON.stringify(value) }];
}

export class LlmProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly kind: 'permanent' | 'retryable' | 'uncertain',
    public readonly retryAfterMs?: number,
  ) { super(code); }
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readJsonWithinLimit(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new LlmProviderError('RESPONSE_TOO_LARGE', 'uncertain');
  }
  if (response.body === null) throw new LlmProviderError('RESPONSE_INVALID', 'uncertain');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new LlmProviderError('RESPONSE_TOO_LARGE', 'uncertain');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LlmProviderError('RESPONSE_INVALID', 'uncertain');
  }
}

export function createLlmProvider(config: AppConfig, apiKey: string, fetcher: typeof fetch = fetch): LlmProvider {
  return {
    async complete(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
      if (config.llm.inputMicrousdPerMillionTokens === null || config.llm.outputMicrousdPerMillionTokens === null) {
        throw new LlmProviderError('PRICING_MISSING', 'permanent');
      }
      if (!config.llm.pricingIncludesAllBillableTokens) throw new LlmProviderError('BILLING_SCOPE_UNVERIFIED', 'permanent');
      const body: Record<string, unknown> = {
        model: config.llm.model,
        messages: serializeLlmMessages(request),
        max_tokens: request.maxOutputTokens,
      };
      if (config.llm.thinking !== undefined) body.thinking = { type: config.llm.thinking };
      const envelope = typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input)
        ? request.input : null;
      if (config.llm.jsonMode === 'json_schema') {
        if (envelope === null || typeof envelope.outputSchema !== 'object' || envelope.outputSchema === null) {
          throw new LlmProviderError('SCHEMA_MISSING', 'permanent');
        }
        body.response_format = { type: 'json_schema', json_schema: {
          name: `${request.stage}_response`, strict: true, schema: envelope.outputSchema,
        } };
      } else if (config.llm.jsonMode === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
      try {
        const response = await fetcher(`${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          const kind = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
            ? 'retryable' : 'permanent';
          throw new LlmProviderError(`HTTP_${response.status}`, kind, retryAfter(response));
        }
        const value = await readJsonWithinLimit(response, config.limits.maxResponseBytes) as {
          id?: string;
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = value.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new LlmProviderError('RESPONSE_INVALID', 'uncertain');
        let parsed: unknown;
        try { parsed = JSON.parse(content); } catch { throw new LlmProviderError('RESPONSE_INVALID', 'uncertain'); }
        const usage = value.usage?.prompt_tokens !== undefined && value.usage.completion_tokens !== undefined
          ? { inputTokens: value.usage.prompt_tokens, outputTokens: value.usage.completion_tokens }
          : null;
        return { value: parsed as LlmResponse['value'], usage, providerRequestId: value.id ?? null };
      } catch (error) {
        if (error instanceof LlmProviderError) throw error;
        throw new LlmProviderError('RESPONSE_UNKNOWN', 'uncertain');
      }
    },
  };
}
