/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ClashResult } from '@ifc-lite/clash';

export interface QualityBand { minimum: number; label: string; color: string }
/** Default colour for a newly configured category; saved policies retain their chosen colour. */
export const newQualityBand = (minimum: number, label: string): QualityBand => ({ minimum, label, color: '#64748b' });
export interface QualityGateConfig { clash: QualityBand[]; duplicates: QualityBand[] }
export type QualityGateStatus = 'evaluated' | 'not-evaluated' | 'unavailable' | 'incomplete' | 'outdated';
export interface QualityGateRow {
  rule: string;
  name: string;
  kind: 'clash' | 'duplicates';
  checked: number | null;
  affected: number | null;
  percent: number | null;
  status: QualityGateStatus;
  models: string[];
  tolerance: number;
  clearance?: number;
  excludeVoidsAndHosts: boolean;
}
export interface QualityGateSnapshot { version: 1; config: QualityGateConfig; rows: QualityGateRow[] }

const bands = (): QualityBand[] => [
  { minimum: 0, label: 'Failed', color: '#dc2626' },
  { minimum: 90, label: 'Partially passed', color: '#ca8a04' },
  { minimum: 95, label: 'Passed', color: '#16a34a' },
];
export const defaultQualityGateConfig = (): QualityGateConfig => ({ clash: bands(), duplicates: bands() });
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function isQualityBands(value: unknown): value is QualityBand[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 12 && value.every((band, index) =>
    record(band) && typeof band.minimum === 'number' && Number.isFinite(band.minimum)
    && band.minimum >= 0 && band.minimum <= 100 && (index === 0 ? band.minimum === 0 : band.minimum > value[index - 1].minimum)
    && typeof band.label === 'string' && band.label.trim().length > 0 && band.label.length <= 100
    && typeof band.color === 'string' && /^#[\da-f]{6}$/i.test(band.color));
}
export function isQualityGateConfig(value: unknown): value is QualityGateConfig {
  return record(value) && isQualityBands(value.clash) && isQualityBands(value.duplicates);
}
/** Half-open bands except the final band, which includes 100. Never classify rounded display values. */
export function qualityBand(percent: number, ranges: readonly QualityBand[]): QualityBand {
  return [...ranges].reverse().find(band => percent >= band.minimum) ?? ranges[0];
}
const identity = (element: { model: string; ref: number }): string => JSON.stringify([element.model, element.ref]);

/** Raw engine findings only: hiding, excluding, accepting or grouping rows does not change physical quality. */
export function evaluateQualityGates(result: ClashResult, stale = false, kind: QualityGateRow['kind'] = 'clash'): QualityGateRow[] {
  const coverage = new Map(result.ruleCoverage?.map(row => [row.rule, row]));
  const affectedByRule = new Map<string, Set<string>>();
  for (const clash of result.clashes) {
    const affected = affectedByRule.get(clash.rule) ?? new Set<string>();
    affected.add(identity(clash.a)); affected.add(identity(clash.b));
    affectedByRule.set(clash.rule, affected);
  }
  return result.rulesRun.map(rule => {
    const matched = coverage.get(rule.id);
    const members = matched?.matchedElements;
    const checked = members ? new Set(members.map(identity)) : null;
    const affected = affectedByRule.get(rule.id) ?? new Set<string>();
    const verified = checked !== null && [...affected].every(key => checked.has(key));
    const emptySide = matched?.matchedA === 0 || matched?.matchedB === 0;
    const status: QualityGateStatus = stale ? 'outdated' : result.truncated ? 'incomplete'
      : !verified ? 'unavailable' : emptySide || checked.size < 2 ? 'not-evaluated' : 'evaluated';
    return {
      rule: rule.id, name: rule.name, kind,
      checked: checked?.size ?? null, affected: verified ? affected.size : null,
      percent: status === 'evaluated' ? 100 * (checked!.size - affected.size) / checked!.size : null,
      status, models: [...new Set(members?.map(element => element.model) ?? [])],
      tolerance: rule.tolerance ?? result.settings.tolerance,
      excludeVoidsAndHosts: result.settings.excludeVoidsAndHosts,
      ...(rule.clearance !== undefined ? { clearance: rule.clearance } : {}),
    };
  });
}

/** Frozen alongside saved report provenance, so later preference edits never reinterpret old evidence. */
export function captureQualityGates(result: ClashResult, config: QualityGateConfig, stale: boolean, kind: QualityGateRow['kind'] = 'clash'): QualityGateSnapshot {
  return { version: 1, config: structuredClone(config), rows: evaluateQualityGates(result, stale, kind) };
}
export function isQualityGateSnapshot(value: unknown): value is QualityGateSnapshot {
  if (!record(value) || value.version !== 1 || !isQualityGateConfig(value.config) || !Array.isArray(value.rows) || value.rows.length > 2000) return false;
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && typeof v === 'number' && v >= 0;
  return value.rows.every(row => {
    if (!record(row) || typeof row.rule !== 'string' || row.rule.length > 2000 || typeof row.name !== 'string' || row.name.length > 2000
      || !['clash', 'duplicates'].includes(String(row.kind)) || !['evaluated', 'not-evaluated', 'unavailable', 'incomplete', 'outdated'].includes(String(row.status))
      || !(row.checked === null || count(row.checked)) || !(row.affected === null || count(row.affected))
      || !Array.isArray(row.models) || row.models.length > 1000 || !row.models.every((id: unknown) => typeof id === 'string' && id.length <= 2000)
      || typeof row.excludeVoidsAndHosts !== 'boolean' || typeof row.tolerance !== 'number' || !Number.isFinite(row.tolerance)
      || (row.clearance !== undefined && (typeof row.clearance !== 'number' || !Number.isFinite(row.clearance)))) return false;
    if (typeof row.affected === 'number' && typeof row.checked === 'number' && row.affected > row.checked) return false;
    return row.status === 'evaluated'
      ? count(row.checked) && row.checked >= 2 && count(row.affected) && row.percent === 100 * (row.checked - row.affected) / row.checked
      : row.percent === null;
  });
}

/** Increase precision until the displayed number stays in the measured category (#9259). */
export function displayQualityPercent(percent: number, ranges?: readonly QualityBand[]): string {
  for (let digits = 1; digits <= 15; digits++) {
    const scale = 10 ** digits;
    const value = Math.floor(percent * scale) / scale;
    if (value <= percent && (!ranges || qualityBand(value, ranges) === qualityBand(percent, ranges))) return value.toFixed(digits);
  }
  return String(percent);
}
