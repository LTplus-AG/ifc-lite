/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export the full compare result as a flat change report (issue #1202).
 *
 * The comparison already produces every signal a coordinator needs; this turns
 * the in-memory diff into a portable list — one row per added / deleted /
 * changed element with its GlobalId, name, type and a human change label — and
 * serializes it to JSON or CSV for reporting and the Practitioner training.
 *
 * Geometry classification (moved / reshaped) reuses the same AABB-centre logic
 * as the detail panel (`summarizeGeometryChange`), but every element's bounds
 * are pre-indexed in a single pass per model so a large report stays O(meshes),
 * not O(elements × meshes).
 */

import type { DiffEntry, DiffState } from '@ifc-lite/diff';
import type { FederatedModel } from '../../store/types.js';
import type { CompareResult } from '../../store/slices/compareSlice.js';
import type { CompareRef } from './buildFingerprints.js';
import { summarizeGeometryChange, type Aabb } from './describeChange.js';
import { downloadBlob, sanitizeFilename } from '../export/download.js';

/** One row of the exported change report. */
export interface CompareReportRow {
  globalId: string;
  name: string;
  ifcType: string;
  /** Raw diff state: added | deleted | modified. */
  state: DiffState;
  /** Human change label: "Added", "Deleted", "Moved", "Reshaped",
   *  "Data changed", or a combination ("Moved, Data changed"). */
  change: string;
  /** AABB-centre displacement in metres (0 when not a move). */
  movedDistance: number;
  /** Which model this row's element lives in (head for add/modify, base for delete). */
  model: string;
}

export interface CompareReport {
  baseModel: string;
  headModel: string;
  scope: string;
  generatedAt: string;
  counts: { added: number; deleted: number; modified: number };
  rows: CompareReportRow[];
}

/** Mutable AABB accumulator. */
interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** One pass over a model's meshes → federation-globalId → AABB. */
function boundsIndex(model: FederatedModel | undefined): Map<number, Aabb> {
  const out = new Map<number, Aabb>();
  if (!model?.geometryResult) return out;
  const acc = new Map<number, Box>();
  for (const mesh of model.geometryResult.meshes) {
    let box = acc.get(mesh.expressId);
    if (!box) {
      box = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
      acc.set(mesh.expressId, box);
    }
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < box.minX) box.minX = x; if (y < box.minY) box.minY = y; if (z < box.minZ) box.minZ = z;
      if (x > box.maxX) box.maxX = x; if (y > box.maxY) box.maxY = y; if (z > box.maxZ) box.maxZ = z;
    }
  }
  for (const [id, b] of acc) {
    out.set(id, { min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ] });
  }
  return out;
}

/** The side actually reported for an entry: base for deletions, head otherwise. */
function reportRef(entry: DiffEntry<CompareRef>): CompareRef | undefined {
  return (entry.state === 'deleted' ? entry.base?.ref : entry.head?.ref) ?? entry.base?.ref;
}

/** Classify a modified entry's change kinds into a human label + move distance. */
function classifyModified(
  entry: DiffEntry<CompareRef>,
  baseBounds: Map<number, Aabb>,
  headBounds: Map<number, Aabb>,
): { change: string; movedDistance: number } {
  const parts: string[] = [];
  let movedDistance = 0;

  if (entry.changeKinds.includes('geometry')) {
    const ba = entry.base ? baseBounds.get(entry.base.ref.globalId) ?? null : null;
    const bb = entry.head ? headBounds.get(entry.head.ref.globalId) ?? null : null;
    const geom = summarizeGeometryChange(ba, bb);
    if (geom) {
      movedDistance = geom.movedDistance;
      if (geom.movedDistance > 0) parts.push('Moved');
      if (geom.reshaped) parts.push('Reshaped');
      if (geom.movedDistance === 0 && !geom.reshaped) parts.push('Geometry changed');
    } else {
      parts.push('Geometry changed');
    }
  }
  if (entry.changeKinds.includes('data')) parts.push('Data changed');

  return { change: parts.join(', ') || 'Changed', movedDistance };
}

/** Build the flat change report from a finished comparison. */
export function buildCompareReport(
  result: CompareResult,
  models: ReadonlyMap<string, FederatedModel>,
): CompareReport {
  const baseModel = models.get(result.baseModelId);
  const headModel = models.get(result.headModelId);
  const baseBounds = boundsIndex(baseModel);
  const headBounds = boundsIndex(headModel);

  const rows: CompareReportRow[] = [];
  for (const entry of result.diff.entries) {
    if (entry.state === 'unchanged') continue;
    const ref = reportRef(entry);
    if (!ref) continue;
    const store = models.get(ref.modelId)?.ifcDataStore;
    const name = store?.entities.getName(ref.localId) || '';
    const ifcType = (entry.head ?? entry.base)?.ifcType ?? 'IfcProduct';
    // The fingerprint key is the GlobalId; synthetic "missing:" keys (entities
    // without a resolvable GlobalId) export blank rather than the placeholder.
    const globalId = entry.key.startsWith('missing:') ? '' : entry.key;
    const modelName = ref.modelId === result.headModelId ? result.headName : result.baseName;

    let change: string;
    let movedDistance = 0;
    if (entry.state === 'added') change = 'Added';
    else if (entry.state === 'deleted') change = 'Deleted';
    else ({ change, movedDistance } = classifyModified(entry, baseBounds, headBounds));

    rows.push({ globalId, name, ifcType, state: entry.state, change, movedDistance, model: modelName });
  }

  // Stable order: added, then changed, then deleted; by type then name within.
  const stateRank: Record<DiffState, number> = { added: 0, modified: 1, deleted: 2, unchanged: 3 };
  rows.sort((a, b) =>
    stateRank[a.state] - stateRank[b.state] ||
    a.ifcType.localeCompare(b.ifcType) ||
    a.name.localeCompare(b.name),
  );

  return {
    baseModel: result.baseName,
    headModel: result.headName,
    scope: result.scope,
    generatedAt: new Date().toISOString(),
    counts: {
      added: result.diff.counts.added,
      deleted: result.diff.counts.deleted,
      modified: result.diff.counts.modified,
    },
    rows,
  };
}

/** Quote a CSV field per RFC 4180 (wrap + double interior quotes when needed)
 *  and neutralise spreadsheet formula injection. A value led by `= + - @` or a
 *  tab/CR is evaluated as a formula by Excel/Sheets; prefixing a single quote
 *  forces it to be read as text (model/element names are attacker-influenced). */
function csvField(value: string | number): string {
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize the report as RFC-4180 CSV (one element per row). */
export function reportToCsv(report: CompareReport): string {
  const header = ['GlobalId', 'Name', 'IfcType', 'Change', 'MovedDistance_m', 'Model'];
  const lines = [header.join(',')];
  for (const r of report.rows) {
    lines.push([
      csvField(r.globalId),
      csvField(r.name),
      csvField(r.ifcType),
      csvField(r.change),
      csvField(r.movedDistance ? r.movedDistance.toFixed(4) : ''),
      csvField(r.model),
    ].join(','));
  }
  return lines.join('\r\n');
}

/** Serialize the report as pretty-printed JSON. */
export function reportToJson(report: CompareReport): string {
  return JSON.stringify(report, null, 2);
}

/** Build + download the change report as a CSV or JSON file. */
export function downloadCompareReport(
  format: 'csv' | 'json',
  result: CompareResult,
  models: ReadonlyMap<string, FederatedModel>,
): void {
  const report = buildCompareReport(result, models);
  const modelName = (s: string) => sanitizeFilename(s, { fallback: 'model', maxLength: 40 });
  const name = `compare-${modelName(report.baseModel)}-vs-${modelName(report.headModel)}`;
  const body = format === 'csv' ? reportToCsv(report) : reportToJson(report);
  const type = format === 'csv' ? 'text/csv;charset=utf-8;' : 'application/json;charset=utf-8;';
  downloadBlob(new Blob([body], { type }), `${name}.${format}`);
}
