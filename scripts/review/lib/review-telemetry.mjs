/* SPDX-License-Identifier: MPL-2.0 */
import { appendFileSync } from 'node:fs';
import { estimateCostUsd } from './review-cost.mjs';

// Never record prompts, credentials, or raw provider errors in usage artifacts.
export function costRecord(model, usage) {
  const costUsd = estimateCostUsd(model, usage);
  return { costUsd, costSource: typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
    ? 'billed' : costUsd === null ? 'unknown' : 'estimated' };
}

export function summarizeCalls(results, failures, validation) {
  return [
    ...results.map((r) => ({
      model: r.model, answered: true, elapsedMs: r.elapsedMs, usage: r.usage, finishReason: r.finishReason,
      ...costRecord(r.model, r.usage),
      poolValidation: validation.get(r.model),
    })),
    ...failures.map((r) => ({ model: r.model, answered: false, elapsedMs: r.elapsedMs, usage: r.usage, finishReason: r.finishReason, ...costRecord(r.model, r.usage) })),
  ];
}

export function appendTelemetry(path, record) {
  appendFileSync(path, `${JSON.stringify({ version: 1, at: new Date().toISOString(), ...record })}\n`);
}
