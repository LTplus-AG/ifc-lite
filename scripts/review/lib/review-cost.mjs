/* SPDX-License-Identifier: MPL-2.0 */
// Fallback rates checked against OpenRouter /api/v1/models on 2026-10-02.
/**
 * USD per MILLION tokens, { in, out }. Static fallback pricing keeps the
 * review lane independent of a pricing API. Extend this table, never
 * invent a price for a model absent from it -- `estimateCostUsd` returns `null`
 * rather than guess.
 */
export const MODEL_PRICES_PER_MTOK = {
  'openai/gpt-6-luna': { in: 0.10, out: 0.50 },
  'openai/gpt-5.6-luna': { in: 0.20, out: 1.20 },
  'deepseek/deepseek-v4.1-flash': { in: 0.30, out: 1.20 },
  'deepseek/deepseek-v4-flash': { in: 0.042, out: 0.084 },
  'openai/gpt-5.4-nano': { in: 0.20, out: 1.25 },
  'anthropic/claude-haiku-4.5': { in: 1.00, out: 5.00 },
  'anthropic/claude-sonnet-5': { in: 2.00, out: 10.00 },
  'anthropic/claude-opus-5.5': { in: 4.00, out: 20.00 },
  'google/gemini-3.5-flash-lite': { in: 0.30, out: 2.50 },
  'openai/gpt-6.1-sol': { in: 2.00, out: 10.00 },
  'anthropic/claude-sonnet-5.5': { in: 2.00, out: 10.00 },
  'openai/gpt-6-sol': { in: 2.00, out: 10.00 },
  'openai/gpt-5.6-sol': { in: 2.00, out: 10.00 },
};

/** @returns {number|null} USD, or null when the model or the usage field is unknown. */
export function estimateCostUsd(model, usage) {
  // OpenRouter's actual charge includes cached and reasoning tokens and routing.
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
  const price = MODEL_PRICES_PER_MTOK[model];
  if (!price || !usage) return null;
  if (usage.prompt_tokens == null && usage.completion_tokens == null) return null;
  const promptTok = Number(usage.prompt_tokens ?? 0);
  const completionTok = Number(usage.completion_tokens ?? 0);
  if (![promptTok, completionTok].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return (promptTok / 1e6) * price.in + (completionTok / 1e6) * price.out;
}

