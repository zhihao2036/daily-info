import type { AppConfig, BudgetedCall, LlmProvider, LlmResponse } from '../domain/contracts';
import { canonicalJson, sha256 } from '../db/repositories/shared';
import { BudgetRepository, estimateCostMicrousd } from './budget';
import { serializeLlmMessages } from './provider';

export interface CompleteBudgetedDependencies {
  db: D1Database;
  config: AppConfig;
  provider: LlmProvider;
  now(): number;
  validate?(stage: BudgetedCall['ownerStage'], value: LlmResponse['value']): LlmResponse['value'];
}

export async function completeBudgeted(input: BudgetedCall, dependencies: CompleteBudgetedDependencies): Promise<LlmResponse> {
  const { config } = dependencies;
  if (config.llm.inputMicrousdPerMillionTokens === null || config.llm.outputMicrousdPerMillionTokens === null) {
    throw new Error('PRICING_MISSING');
  }
  if (!config.llm.pricingIncludesAllBillableTokens) throw new Error('BILLING_SCOPE_UNVERIFIED');
  const cacheKey = await sha256(canonicalJson({
    input: input.request.input,
    stage: input.request.stage,
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
    promptVersion: config.llm.promptVersion,
    jsonMode: config.llm.jsonMode,
    ...(config.llm.thinking === undefined ? {} : { thinking: config.llm.thinking }),
  }));
  const budget = new BudgetRepository(dependencies.db);
  const cached = await budget.findCached(cacheKey);
  if (cached !== null) {
    try {
      const value = dependencies.validate?.(input.ownerStage, cached.value) ?? cached.value;
      return { ...cached, value, providerRequestId: null };
    } catch { /* Invalid legacy cache entries are not reusable. */ }
  }
  const inputUpper = new TextEncoder().encode(JSON.stringify(serializeLlmMessages(input.request))).byteLength;
  const reservationMicrousd = estimateCostMicrousd(
    inputUpper,
    input.request.maxOutputTokens,
    config.llm.inputMicrousdPerMillionTokens,
    config.llm.outputMicrousdPerMillionTokens,
  );
  const reservation = await budget.reserve({
    invocationId: input.invocationId,
    attemptNo: input.attemptNo,
    cacheKey,
    generation: input.generation,
    deadlineAt: input.deadlineAt,
    digestId: input.request.digestId,
    stage: input.request.stage,
    model: config.llm.model,
    promptVersion: config.llm.promptVersion,
    reservationMicrousd,
    dayLimitMicrousd: config.budget.dayMicrousd,
    monthLimitMicrousd: config.budget.monthMicrousd,
    now: dependencies.now(),
  });
  if (!await budget.markCalling(reservation.callId, dependencies.now())) {
    // A replay can observe `calling` after the original invocation reached the provider.
    // Only a still-reserved row is provably uncalled and safe to release here.
    await budget.releaseUncalled(reservation.callId, 'CALL_FENCED', dependencies.now(), 'reserved');
    throw new Error('CALL_FENCED');
  }
  const remaining = Math.min(input.deadlineAt - dependencies.now(), config.limits.llmTimeoutMs);
  if (remaining <= 0) {
    await budget.releaseUncalled(reservation.callId, 'CALL_DEADLINE', dependencies.now(), 'calling');
    throw new Error('CALL_DEADLINE');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    const raw = await dependencies.provider.complete(input.request, controller.signal);
    const response = { ...raw, value: dependencies.validate?.(input.ownerStage, raw.value) ?? raw.value };
    const actual = response.usage === null ? null : estimateCostMicrousd(
      response.usage.inputTokens,
      response.usage.outputTokens,
      config.llm.inputMicrousdPerMillionTokens,
      config.llm.outputMicrousdPerMillionTokens,
    );
    await budget.settleSuccess(reservation.callId, response.value, response.usage, actual, dependencies.now());
    return response;
  } catch (error) {
    await budget.settleUncertain(reservation.callId, error instanceof Error ? error.message : 'RESPONSE_UNKNOWN', dependencies.now());
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
