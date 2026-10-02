/* SPDX-License-Identifier: MPL-2.0 */
import { appendFileSync } from 'node:fs';
import { estimateCostUsd } from './review-cost.mjs';

// Never record prompts, credentials, or raw provider errors in usage artifacts.
export function summarizeCalls(results, failures, validation) {
  return [
    ...results.map((r) => ({
      model: r.model, answered: true, elapsedMs: r.elapsedMs, usage: r.usage,
      costUsd: estimateCostUsd(r.model, r.usage),
      costSource: typeof r.usage?.cost === 'number' && Number.isFinite(r.usage.cost) && r.usage.cost >= 0 ? 'billed' : estimateCostUsd(r.model, r.usage) === null ? 'unknown' : 'estimated',
      poolValidation: validation.get(r.model),
    })),
    ...failures.map((r) => ({ model: r.model, answered: false, elapsedMs: r.elapsedMs, costUsd: null, costSource: 'unknown' })),
  ];
}

export function appendTelemetry(path, record) {
  appendFileSync(path, `${JSON.stringify({ version: 1, at: new Date().toISOString(), ...record })}\n`);
}
