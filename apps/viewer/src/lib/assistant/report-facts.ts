/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source-independent reading of captured evidence for report claims (#6918):
 * field paths into rows, declared units, value comparison and row identity.
 * Nothing here knows a particular analysis; an evidence source states units
 * by including them in its rows or summary (`<field>Unit`, `unit`, `units`).
 */

import { displayScalar } from './captured-rows';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** `summary` addresses the native summary; every other citation addresses a captured row. */
export const SUMMARY_CITATION = 'summary';

const SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

/** Value at a dotted path (`a.tag`, `requirementResults[0].actualValue`); `undefined` when absent. */
export function valueAt(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const match of path.matchAll(SEGMENT)) {
    if (match[2] !== undefined) current = Array.isArray(current) ? current[Number(match[2])] : undefined;
    else current = record(current) && Object.hasOwn(current, match[1]) ? current[match[1]] : undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

/** The unit the evidence declares for a field, looked up generically beside it, on the row and in the summary. */
export function declaredUnit(row: unknown, summary: unknown, path: string): string | undefined {
  const leaf = path.replace(/\[\d+\]/g, '').split('.').pop() ?? path;
  const parent = path.includes('.') ? valueAt(row, path.slice(0, path.lastIndexOf('.'))) : row;
  for (const holder of [parent, row]) {
    if (!record(holder)) continue;
    if (typeof holder[`${leaf}Unit`] === 'string') return holder[`${leaf}Unit`] as string;
    if (record(holder.units) && typeof holder.units[leaf] === 'string') return holder.units[leaf] as string;
  }
  if (record(row) && typeof row.unit === 'string') return row.unit;
  if (record(summary) && record(summary.units) && typeof summary.units[leaf] === 'string') return summary.units[leaf] as string;
  return undefined;
}

const UNITS: Record<string, [dimension: string, factor: number]> = {
  mm: ['length', 1e-3], cm: ['length', 1e-2], dm: ['length', 1e-1], m: ['length', 1], km: ['length', 1e3],
  mm2: ['area', 1e-6], cm2: ['area', 1e-4], m2: ['area', 1], mm3: ['volume', 1e-9], cm3: ['volume', 1e-6], m3: ['volume', 1],
  l: ['volume', 1e-3], g: ['mass', 1e-3], kg: ['mass', 1], t: ['mass', 1e3], s: ['time', 1], min: ['time', 60], h: ['time', 3600],
  deg: ['angle', Math.PI / 180], rad: ['angle', 1], '%': ['ratio', 0.01], ratio: ['ratio', 1],
};
const ALIASES: Record<string, string> = { metre: 'm', meter: 'm', metres: 'm', meters: 'm', millimetre: 'mm', millimeter: 'mm',
  millimetres: 'mm', millimeters: 'mm', sqm: 'm2', '°': 'deg', degree: 'deg', degrees: 'deg', percent: '%' };

function unitKey(unit: string): string {
  const key = unit.trim().toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/\^/g, '');
  return ALIASES[key] ?? key;
}

export type FactCheck =
  | { kind: 'match'; captured: unknown; unit?: string }
  | { kind: 'mismatch'; captured: unknown; unit?: string; reason: string }
  | { kind: 'unverifiable'; captured: unknown; unit?: string; reason: string };

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(value)) return Number(value.replace(',', '.'));
  return null;
}

/**
 * Rounding a claim may state, in claimed units: only a string that writes out its decimals ("2.40")
 * states one. A JSON number has lost its trailing zeros (-0.10 arrives as -0.1, 0 says nothing about
 * millimetres), so it is compared exactly.
 */
function statedRounding(value: string | number): number {
  if (typeof value === 'number') return 0;
  const decimals = /[.,](\d+)\s*$/.exec(value)?.[1].length;
  return decimals === undefined ? 0 : 0.5 * 10 ** -decimals;
}

/** Claimed value against captured value: exact unless a decimal string states its rounding. Unknown units never pass and never contradict a value. */
export function compareFact(claimed: string | number | boolean, claimedUnit: string | undefined, captured: unknown, capturedUnit: string | undefined): FactCheck {
  const base = { captured, unit: capturedUnit };
  if (captured === undefined) return { kind: 'unverifiable', ...base, reason: 'field not present in the captured evidence' };
  if (typeof captured === 'string' && captured.startsWith('[omitted:')) return { kind: 'unverifiable', ...base, reason: 'value omitted from the captured evidence' };
  const capturedNumber = typeof captured === 'number' ? captured : null;
  const claimedNumber = typeof claimed === 'boolean' ? null : numeric(claimed);
  if (capturedNumber !== null && claimedNumber !== null && typeof claimed !== 'boolean') {
    let factor = 1;
    if (claimedUnit && (!capturedUnit || unitKey(claimedUnit) !== unitKey(capturedUnit))) {
      if (!capturedUnit) return { kind: 'unverifiable', ...base, reason: `the evidence does not record a unit for comparison with ${claimedUnit}` };
      const from = UNITS[unitKey(claimedUnit)], to = UNITS[unitKey(capturedUnit)];
      if (!from || !to) return { kind: 'unverifiable', ...base, reason: `units ${claimedUnit} and ${capturedUnit} cannot be compared` };
      if (from[0] !== to[0]) return { kind: 'mismatch', ...base, reason: `unit ${claimedUnit} is not a ${to[0]} unit like ${capturedUnit}` };
      factor = from[1] / to[1];
    }
    const converted = claimedNumber * factor;
    // Relative 1e-9 absorbs unit-conversion float noise, never a different value.
    const tolerance = Math.max(statedRounding(claimed) * factor, Math.max(Math.abs(converted), Math.abs(capturedNumber)) * 1e-9);
    return Math.abs(converted - capturedNumber) <= tolerance ? { kind: 'match', ...base }
      : { kind: 'mismatch', ...base, reason: 'value differs from the captured value' };
  }
  if (capturedNumber !== null) return { kind: 'mismatch', ...base, reason: 'the captured value is a number' };
  if (typeof captured === 'boolean' || typeof claimed === 'boolean') {
    return captured === claimed ? { kind: 'match', ...base } : { kind: 'mismatch', ...base, reason: 'value differs from the captured value' };
  }
  if (typeof captured === 'string') {
    return String(claimed).trim().toLowerCase() === captured.trim().toLowerCase() ? { kind: 'match', ...base }
      : { kind: 'mismatch', ...base, reason: 'value differs from the captured value' };
  }
  return { kind: 'unverifiable', ...base, reason: captured === null ? 'the captured value is empty' : 'the captured value is not a single value' };
}

/** Field names that identify a native row across captures, in any source. */
const IDENTITY_PATHS = ['id', 'key', 'guid', 'globalId', 'GlobalId', 'specificationId', 'specification.id', 'modelId', 'expressId'];

/**
 * A stable identity for a captured row: its identity fields when it has any,
 * else its complete content (so an identity-less row only matches itself).
 */
export function rowIdentity(data: unknown): string {
  const parts = IDENTITY_PATHS.flatMap(path => {
    const value = valueAt(data, path);
    return typeof value === 'string' || typeof value === 'number' ? [`${path}=${value}`] : [];
  });
  return parts.length ? parts.join('|') : `content:${JSON.stringify(data)}`;
}

/** Citation of each row identity in a capture; ambiguous identities resolve to nothing. */
export function citationsByIdentity(rows: Map<string, unknown>): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const [citation, data] of rows) {
    const key = rowIdentity(data);
    index.set(key, index.has(key) ? null : citation);
  }
  return index;
}

/** Readable `value unit` for document text. */
export function formatFactValue(value: unknown, unit?: string): string {
  const text = value === undefined ? 'not present' : value === null ? 'empty' : displayScalar(value);
  return unit ? `${text} ${unit}` : text;
}
