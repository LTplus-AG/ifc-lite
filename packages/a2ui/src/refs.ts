/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wire encoding for model-aware entity references inside A2UI data models.
 *
 * A2UI data is JSON, so an `EntityRef` (`{ modelId, expressId }`) travels as the
 * string `"<modelId>:<expressId>"`. Express ids repeat across federated models,
 * so a bare number is never a valid ref. Model ids may themselves contain `:`,
 * which is why parsing splits on the last one.
 */

export interface WireEntityRef {
  modelId: string;
  expressId: number;
}

export function encodeRef(ref: WireEntityRef): string {
  return `${ref.modelId}:${ref.expressId}`;
}

export function parseRef(value: unknown): WireEntityRef | null {
  if (typeof value !== 'string') return null;
  const at = value.lastIndexOf(':');
  if (at <= 0 || at === value.length - 1) return null;
  const digits = value.slice(at + 1);
  if (!/^\d+$/.test(digits)) return null;
  const expressId = Number(digits);
  if (!Number.isSafeInteger(expressId) || expressId <= 0) return null;
  return { modelId: value.slice(0, at), expressId };
}

/** Parse a list, dropping malformed entries and duplicates, keeping order. */
export function parseRefs(values: unknown): WireEntityRef[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: WireEntityRef[] = [];
  for (const value of values) {
    const ref = parseRef(value);
    if (!ref) continue;
    const key = encodeRef(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
