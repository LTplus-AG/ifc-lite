/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Read-only views of a captured evidence payload for people, not models. */

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export interface CapturedEvidence {
  summary: unknown;
  rows: Map<string, unknown>;
}

/** Captured rows by citation; null when the payload is not a bounded evidence envelope. */
export function capturedEvidence(payload: string): CapturedEvidence | null {
  if (payload.length > 200_000) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(payload); }
  catch (error) { console.warn('[Assistant] Captured evidence is not JSON', error); return null; }
  if (!record(parsed) || !record(parsed.evidence) || !Array.isArray(parsed.evidence.rows)) return null;
  const rows = new Map<string, unknown>();
  for (const row of parsed.evidence.rows) {
    if (record(row) && typeof row.citation === 'string' && !rows.has(row.citation)) rows.set(row.citation, row.data);
  }
  return { summary: parsed.evidence.summary, rows };
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  if (typeof value === 'string') return value || '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return JSON.stringify(value);
}

/** Flattened `path: value` pairs; arrays of scalars join, deeper structure keeps dotted paths. */
export function rowFields(value: unknown, prefix = '', depth = 0): Array<[string, string]> {
  if (Array.isArray(value)) {
    if (value.every(item => !record(item) && !Array.isArray(item))) return [[prefix || 'value', value.length ? value.map(scalar).join(', ') : '—']];
    if (depth > 3) return [[prefix || 'value', JSON.stringify(value)]];
    return value.flatMap((item, index) => rowFields(item, `${prefix}[${index}]`, depth + 1));
  }
  if (!record(value)) return [[prefix || 'value', scalar(value)]];
  if (depth > 3) return [[prefix || 'value', JSON.stringify(value)]];
  return Object.entries(value).flatMap(([key, item]) => rowFields(item, prefix ? `${prefix}.${key}` : key, depth + 1));
}
