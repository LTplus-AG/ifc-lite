/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { UsageReceipt } from './request-receipts';

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** #7242 portable metadata only; never retain unknown request/transport fields. */
export function decodeUsageReceipt(value: unknown): UsageReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, model, route, startedAt, finishedAt, outcome, usageReported, outputFormat, inputTokens, outputTokens } = value as Record<string, unknown>;
  if (!identifier(id) || !identifier(model)
    || (route !== 'proxy' && route !== 'openai' && route !== 'anthropic')
    || !count(startedAt) || !count(finishedAt) || finishedAt < startedAt
    || (outcome !== 'completed' && outcome !== 'truncated' && outcome !== 'cancelled' && outcome !== 'timeout' && outcome !== 'error')
    || (outputFormat !== undefined && outputFormat !== 'text' && outputFormat !== 'json-schema')) return null;
  const base: Pick<UsageReceipt, 'id' | 'model' | 'route' | 'startedAt' | 'finishedAt' | 'outcome' | 'outputFormat'> = { id, model, route, startedAt, finishedAt, outcome, ...(outputFormat === undefined ? {} : { outputFormat }) };
  if (usageReported === false) return { ...base, usageReported: false };
  if (usageReported !== true || !count(inputTokens) || !count(outputTokens)) return null;
  return { ...base, usageReported: true, inputTokens, outputTokens };
}
