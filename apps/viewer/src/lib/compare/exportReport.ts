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
import { contentMatchCounts } from './contentMatches.js';
import { productTypeSplit, type ProductTypeTally } from './productTypeCounts.js';
import {
  annotateReviewGroups,
  contentMatchReportRows,
  exportedGlobalId,
  type CompareReportRow,
} from './reportRows.js';
import { placementMoveSummary, summarizeGeometryChange, type Aabb } from './geometrySummary.js';
import { downloadBlob, sanitizeFilename } from '../export/download.js';

export type { CompareReportRow } from './reportRows.js';

export interface CompareReport {
  baseModel: string;
  headModel: string;
  scope: string;
  generatedAt: string;
  /** IFC classes excluded from the comparison (the blacklist, #1470). Empty when
   *  none were excluded. Recorded so a report reader knows what was ignored. */
  excludedTypes: string[];
  /**
   * `matched` counts elements the content pass retired out of `added`/`deleted`
   * (#1891); `needsReview` counts entities left in an unresolved group. Both
   * are 0 when the pass did not run. Without them a reader would take a lower
   * added/deleted count at face value.
   *
   * `added`/`deleted`/`modified` total BOTH products and type objects, the way
   * the engine's own `DiffCounts` does. `products`/`typeObjects` break that
   * total down (issue: a certification exercise's expected answer counts
   * products only, and a reader taking the combined number gets a mismatch —
   * see `productTypeCounts.ts`). The combined fields stay for readers already
   * consuming them; the split is additive.
   */
  counts: {
    added: number;
    deleted: number;
    modified: number;
    matched: number;
    needsReview: number;
    products: ProductTypeTally;
    typeObjects: ProductTypeTally;
  };
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

/**
 * The GlobalId reported for an entry — taken from the same side as
 * {@link reportRef}, not from `entry.key`.
 *
 * Those are the same string until an identity map is in play. Under
 * `DiffOptions.keyAliases` (#1891) an aliased pair's `entry.key` is the *base*
 * key, deliberately: the alias renames the pair, and the head fingerprint keeps
 * its own key on `entry.head.key`. Keying a head row off `entry.key` would
 * therefore print the element's OLD GlobalId next to its current name and type
 * — a row that resolves to nothing in the file it claims to describe, and one
 * that would silently disagree with every other export.
 *
 * The viewer does not pass `keyAliases` today, so no shipped path can produce
 * an aliased entry; this reads the side it always meant to read, so that adding
 * the alias to Compare mode is a one-line change and not a data-integrity bug.
 */
function reportKey(entry: DiffEntry<CompareRef>): string {
  return (
    (entry.state === 'deleted' ? entry.base?.key : entry.head?.key) ?? entry.base?.key ?? entry.key
  );
}

/** Classify a modified entry's change kinds into a human label + move distance. */
function classifyModified(
  entry: DiffEntry<CompareRef>,
  baseBounds: Map<number, Aabb>,
  headBounds: Map<number, Aabb>,
  baseModel: FederatedModel | undefined,
  headModel: FederatedModel | undefined,
): { change: string; movedDistance: number } {
  const parts: string[] = [];
  let movedDistance = 0;

  if (entry.changeKinds.includes('geometry')) {
    const ba = entry.base ? baseBounds.get(entry.base.ref.globalId) ?? null : null;
    const bb = entry.head ? headBounds.get(entry.head.ref.globalId) ?? null : null;
    // A pair that is geometry-less on BOTH sides (the summary checks
    // `ref.meshed`; missing boxes alone also describe a GPU-instanced entity)
    // is described by its composed world placement (buildFingerprints.ts) —
    // `summarizeGeometryChange(null, null)` answers "Reshaped", which is false
    // for a product with no shape, and it leaves `MovedDistance_m` empty on
    // the one row that column was made for. Same helper as the detail panel
    // (`describeChange.ts`), so the CSV and the panel cannot disagree.
    const bothMeshless =
      !ba && !bb && entry.base?.ref.meshed === false && entry.head?.ref.meshed === false;
    const geom = bothMeshless
      ? (entry.base && entry.head
          ? placementMoveSummary(baseModel, entry.base.ref, headModel, entry.head.ref)
          : null)
      : summarizeGeometryChange(ba, bb);
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

/** Build the flat change report from a finished comparison.
 *
 * `excludedTypesDisplay` is the viewer's blacklist in its original IFC casing
 * (e.g. `IfcOpeningElement`); the engine's `result.diff.excludedTypes` is
 * uppercase-normalized, so we prefer the display form for a human-readable
 * report and fall back to the normalized set when it isn't supplied (#1470). */
export function buildCompareReport(
  result: CompareResult,
  models: ReadonlyMap<string, FederatedModel>,
  excludedTypesDisplay: readonly string[] = [],
): CompareReport {
  const baseModel = models.get(result.baseModelId);
  const headModel = models.get(result.headModelId);
  const baseBounds = boundsIndex(baseModel);
  const headBounds = boundsIndex(headModel);

  const rows: CompareReportRow[] = [];
  // Row → the federation global id it was built from, so the unresolved-group
  // annotation can find its rows without re-deriving the ref.
  const rowGlobalIds = new Map<CompareReportRow, number>();
  for (const entry of result.diff.entries) {
    if (entry.state === 'unchanged') continue;
    const ref = reportRef(entry);
    if (!ref) continue;
    const store = models.get(ref.modelId)?.ifcDataStore;
    const name = store?.entities.getName(ref.localId) || '';
    const ifcType = (entry.head ?? entry.base)?.ifcType ?? 'IfcProduct';
    // The fingerprint key is the GlobalId; synthetic "missing:" keys (entities
    // without a resolvable GlobalId) export blank rather than the placeholder.
    const globalId = exportedGlobalId(reportKey(entry));
    const modelName = ref.modelId === result.headModelId ? result.headName : result.baseName;

    let change: string;
    let movedDistance = 0;
    if (entry.state === 'added') change = 'Added';
    else if (entry.state === 'deleted') change = 'Deleted';
    else ({ change, movedDistance } = classifyModified(entry, baseBounds, headBounds, baseModel, headModel));

    const row: CompareReportRow = { globalId, name, ifcType, state: entry.state, change, movedDistance, model: modelName };
    rows.push(row);
    rowGlobalIds.set(row, ref.globalId);
  }

  // Content matches (#1891), added on top of the entry-derived rows rather than
  // replacing anything: retiring matches contribute their own rows, unresolved
  // groups annotate the add/delete rows that are already here.
  const matches = result.diff.contentMatches ?? [];
  rows.push(...contentMatchReportRows(matches, models, result.headName));
  annotateReviewGroups(rows, matches, rowGlobalIds);

  // Stable order: added, then changed, then matched, then deleted; by type then
  // name within.
  const stateRank: Record<DiffState | 'matched', number> = {
    added: 0,
    modified: 1,
    matched: 2,
    deleted: 3,
    unchanged: 4,
  };
  rows.sort((a, b) =>
    stateRank[a.state] - stateRank[b.state] ||
    a.ifcType.localeCompare(b.ifcType) ||
    a.name.localeCompare(b.name),
  );

  const matchTally = contentMatchCounts(result.diff.contentMatches);
  const split = productTypeSplit(result.diff.entries);

  return {
    baseModel: result.baseName,
    headModel: result.headName,
    scope: result.scope,
    generatedAt: new Date().toISOString(),
    excludedTypes:
      excludedTypesDisplay.length > 0 ? [...excludedTypesDisplay] : [...result.diff.excludedTypes],
    counts: {
      added: result.diff.counts.added,
      deleted: result.diff.counts.deleted,
      modified: result.diff.counts.modified,
      matched: matchTally.matchedElements,
      needsReview: matchTally.needsReviewElements,
      products: split.products,
      typeObjects: split.typeObjects,
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
  // Strip EVERY leading invisible before the trigger test, not just the BOM.
  // Spreadsheet importers treat a BOM as file metadata, but a zero-width space
  // (U+200B), an LTR mark (U+200E), a non-breaking space (U+00A0) or a line /
  // paragraph separator (U+2028/U+2029) in front of `=` likewise does not stop
  // a spreadsheet reading the cell as a formula -- while it DOES stop the
  // anchored test below matching, so the apostrophe never gets prepended.
  // Fixing only the BOM leaves the guard bypassable, which for a CSV-injection
  // guard means it still fails in the way that matters.
  //
  // `\p{Z}`, not `\p{Zs}`: the separator category also covers `Zl` and `Zp`
  // (U+2028/U+2029). Same class as `lists/export/model.ts`.
  s = s.replace(/^[\p{Cf}\p{Z}]+/u, '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize the report as RFC-4180 CSV (one element per row). */
export function reportToCsv(report: CompareReport): string {
  // `Match` / `MatchedGlobalId` are appended, never inserted: an existing
  // consumer reading the first six columns positionally keeps working (#1891).
  const header = [
    'GlobalId', 'Name', 'IfcType', 'Change', 'MovedDistance_m', 'Model', 'Match', 'MatchedGlobalId',
  ];
  const lines: string[] = [];
  // The row count below totals products AND type objects together (`Change`
  // in `Added`/`Deleted`/`Modified` counts both), the same conflation the
  // panel's counts grid has - a certification exercise's expected answer
  // counts products only. Lead with the split so a reader taking the row
  // count at face value is not misled the way the combined headline was
  // (see `productTypeCounts.ts`). Omitted entirely when there are no
  // type-object changes, so a report with none reads exactly as before.
  const { products, typeObjects } = report.counts;
  if (typeObjects.added + typeObjects.modified + typeObjects.deleted > 0) {
    lines.push(
      csvField(
        `# Products: ${products.added} added, ${products.modified} modified, ${products.deleted} deleted` +
          ` | Type objects: ${typeObjects.added} added, ${typeObjects.modified} modified, ${typeObjects.deleted} deleted`,
      ),
    );
  }
  // Provenance: a blacklist removes rows, so a CSV that looks "complete" would
  // mislead a coordinator (the ignored elements are simply gone). Lead with a
  // comment naming the excluded classes so the omission is never silent (#1470).
  // Starts with `#`, so it is not a formula-injection vector and standard CSV
  // readers surface it as a single leading cell rather than corrupting columns.
  if (report.excludedTypes.length > 0) {
    lines.push(csvField(`# Excluded classes (not compared): ${report.excludedTypes.join(', ')}`));
  }
  lines.push(header.join(','));
  for (const r of report.rows) {
    lines.push([
      csvField(r.globalId),
      csvField(r.name),
      csvField(r.ifcType),
      csvField(r.change),
      csvField(r.movedDistance ? r.movedDistance.toFixed(4) : ''),
      csvField(r.model),
      csvField(r.match ?? ''),
      csvField(r.matchedGlobalId ?? ''),
    ].join(','));
  }
  return lines.join('\r\n');
}

/** Serialize the report as pretty-printed JSON. */
export function reportToJson(report: CompareReport): string {
  return JSON.stringify(report, null, 2);
}

/** Build + download the change report as a CSV or JSON file.
 *  `excludedTypesDisplay` carries the blacklist in its original IFC casing for
 *  the report header (the engine echo is uppercase-normalized). */
export function downloadCompareReport(
  format: 'csv' | 'json',
  result: CompareResult,
  models: ReadonlyMap<string, FederatedModel>,
  excludedTypesDisplay: readonly string[] = [],
): void {
  const report = buildCompareReport(result, models, excludedTypesDisplay);
  const modelName = (s: string) => sanitizeFilename(s, { fallback: 'model', maxLength: 40 });
  const name = `compare-${modelName(report.baseModel)}-vs-${modelName(report.headModel)}`;
  const body = format === 'csv' ? reportToCsv(report) : reportToJson(report);
  const type = format === 'csv' ? 'text/csv;charset=utf-8;' : 'application/json;charset=utf-8;';
  downloadBlob(new Blob([body], { type }), `${name}.${format}`);
}
