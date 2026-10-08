/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { UsageReceipt } from './request-receipts';

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

type Provenance = NonNullable<UsageReceipt['provenance']>;
function decodeProvenance(value: unknown): Provenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { contractVersion, promptVersion, grantedOutputTokens, timeoutMs, finishReason, inputDigest, inputDigestUnavailable, outputTextDigest } = value as Record<string, unknown>;
  const reasons: Provenance['finishReason'][] = ['stop', 'length', 'max_tokens', 'end_turn', 'stop_sequence', 'tool_calls', 'function_call', 'content_filter', 'refusal', 'pause_turn', 'unknown'];
  const safeReason = reasons.find(reason => reason === finishReason);
  if (contractVersion !== 'ifc-lite.ai.request.v1' || !count(grantedOutputTokens) || grantedOutputTokens === 0
    || !count(timeoutMs) || timeoutMs === 0 || timeoutMs > 2_147_483_647 || !safeReason
    || (promptVersion !== undefined && (typeof promptVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(promptVersion)))) return null;
  const digest = <Referent extends string>(raw: unknown, referent: Referent) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    return record.algorithm === 'sha256' && record.referent === referent && typeof record.value === 'string' && /^[a-f0-9]{64}$/.test(record.value)
      ? { algorithm: 'sha256' as const, referent, value: record.value } : null;
  };
  const input = inputDigest === undefined ? undefined : digest(inputDigest, 'logical-input.v1');
  const output = outputTextDigest === undefined ? undefined : digest(outputTextDigest, 'output-text.utf8.v1');
  if (input === null || output === null || (inputDigestUnavailable !== undefined && inputDigestUnavailable !== 'non-json-input' && inputDigestUnavailable !== 'digest-limit')
    || (!!input === (inputDigestUnavailable !== undefined))) return null;
  return {
    contractVersion, grantedOutputTokens, timeoutMs, finishReason: safeReason,
    ...(promptVersion === undefined ? {} : { promptVersion }),
    ...(input ? { inputDigest: input } : { inputDigestUnavailable: inputDigestUnavailable === 'digest-limit' ? 'digest-limit' as const : 'non-json-input' as const }),
    ...(output ? { outputTextDigest: output } : {}),
  };
}

/** #7242 portable metadata only; never retain unknown request/transport fields. */
export function decodeUsageReceipt(value: unknown): UsageReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, model, route, startedAt, finishedAt, outcome, usageReported, outputFormat, inputTokens, outputTokens, provenance } = value as Record<string, unknown>;
  const decodedProvenance = provenance === undefined ? undefined : decodeProvenance(provenance);
  if (!identifier(id) || !identifier(model)
    || (route !== 'proxy' && route !== 'openai' && route !== 'anthropic')
    || !count(startedAt) || !count(finishedAt) || finishedAt < startedAt
    || (outcome !== 'completed' && outcome !== 'truncated' && outcome !== 'cancelled' && outcome !== 'timeout' && outcome !== 'error')
    || decodedProvenance === null || (outputFormat !== undefined && outputFormat !== 'text' && outputFormat !== 'json-schema')) return null;
  const base: Pick<UsageReceipt, 'id' | 'model' | 'route' | 'startedAt' | 'finishedAt' | 'outcome' | 'outputFormat' | 'provenance'> = { id, model, route, startedAt, finishedAt, outcome, ...(outputFormat === undefined ? {} : { outputFormat }), ...(decodedProvenance ? { provenance: decodedProvenance } : {}) };
  if (usageReported === false) return { ...base, usageReported: false };
  if (usageReported !== true || !count(inputTokens) || !count(outputTokens)) return null;
  return { ...base, usageReported: true, inputTokens, outputTokens };
}
