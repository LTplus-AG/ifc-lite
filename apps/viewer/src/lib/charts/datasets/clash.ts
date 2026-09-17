/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `clash` chart dataset (#3944): one row per clash of the current run
 * (after exclusions), both elements' renderer ids on the row, the columns a
 * coordinator charts by — rule, severity, detection status, review status,
 * the two IFC types and their pair, the two models, the storey of element A
 * (resolved through the federation like the CSV export) and the signed
 * distance for a penetration histogram.
 */
import type { ChartDataset, ChartDatasetColumn, ChartDatasetRow } from '@ifc-lite/charts';
import { clashReviewKey, DEFAULT_CLASH_REVIEW_STATUS, type ClashElementRef } from '@ifc-lite/clash';
import type { ViewerState } from '@/store';

export const CLASH_COLUMNS = {
  rule: 'Rule',
  severity: 'Severity',
  status: 'Status',
  review: 'Review',
  typeA: 'TypeA',
  typeB: 'TypeB',
  typePair: 'TypePair',
  modelA: 'ModelA',
  modelB: 'ModelB',
  storey: 'Storey',
  distance: 'Distance',
  group: 'Group',
} as const;

export const CLASH_DATASET_COLUMNS: ChartDatasetColumn[] = [
  { id: CLASH_COLUMNS.rule, label: 'Rule', kind: 'category' },
  { id: CLASH_COLUMNS.severity, label: 'Severity', kind: 'category' },
  { id: CLASH_COLUMNS.status, label: 'Detection (hard / clearance / touch)', kind: 'category' },
  { id: CLASH_COLUMNS.review, label: 'Review status', kind: 'category' },
  { id: CLASH_COLUMNS.typeA, label: 'Type A', kind: 'category' },
  { id: CLASH_COLUMNS.typeB, label: 'Type B', kind: 'category' },
  { id: CLASH_COLUMNS.typePair, label: 'Type pair', kind: 'category' },
  { id: CLASH_COLUMNS.modelA, label: 'Model A', kind: 'category' },
  { id: CLASH_COLUMNS.modelB, label: 'Model B', kind: 'category' },
  { id: CLASH_COLUMNS.storey, label: 'Storey', kind: 'category' },
  { id: CLASH_COLUMNS.distance, label: 'Distance', kind: 'number', unit: 'm' },
  { id: CLASH_COLUMNS.group, label: 'Group', kind: 'category' },
];

export type ClashDatasetState = Pick<ViewerState, 'clashResult' | 'clashReviews' | 'clashGroups' | 'clashRunSeq' | 'models' | 'resolveGlobalIdInModel'>;

/** Storey of an element, resolved like the CSV export: renderer id → local id → spatial hierarchy. */
function storeyOf(state: ClashDatasetState, ref: ClashElementRef): string {
  const hit = state.resolveGlobalIdInModel(ref.model, ref.ref);
  if (!hit) return '';
  const store = state.models.get(hit.modelId)?.ifcDataStore;
  const storeyId = store?.spatialHierarchy?.elementToStorey.get(hit.expressId);
  return storeyId ? store?.entities.getName(storeyId) || '' : '';
}

/** FNV-1a over a sequence of strings; order-sensitive, so a moved member changes it. */
function fingerprintStrings(parts: Iterable<string>): string {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function buildClashDataset(state: ClashDatasetState): ChartDataset {
  const result = state.clashResult;
  const rows: ChartDatasetRow[] = [];
  const groupOf = new Map<string, string>();
  if (result) {
    for (const group of state.clashGroups ?? []) for (const member of group.members) groupOf.set(member.id, group.title);
    const modelName = (id: string): string => state.models.get(id)?.name ?? id;
    for (const clash of result.clashes) {
      const review = state.clashReviews.get(clashReviewKey(clash));
      const typeA = clash.a.tag;
      const typeB = clash.b.tag;
      rows.push({
        ids: [clash.a.ref, clash.b.ref],
        values: [
          clash.rule,
          clash.severity,
          clash.status,
          review?.status ?? DEFAULT_CLASH_REVIEW_STATUS,
          typeA,
          typeB,
          typeA <= typeB ? `${typeA} vs ${typeB}` : `${typeB} vs ${typeA}`,
          modelName(clash.a.model),
          modelName(clash.b.model),
          storeyOf(state, clash.a),
          clash.distance,
          groupOf.get(clash.id) ?? '',
        ],
      });
    }
  }
  // Reviews and groups change without a new run, so their CONTENT is part of
  // the identity: a status edit keeps `clashReviews.size`, and a manual
  // regroup keeps the row count, yet both move rows between buckets. A
  // fingerprint that missed them let a selected top-N "Other" bucket stay
  // live after its members had been regrouped away (#4833).
  const reviews = fingerprintStrings([...state.clashReviews].map(([key, review]) => `${key}=${review.status}`).sort());
  const groups = fingerprintStrings([...groupOf].map(([id, title]) => `${id}=${title}`).sort());
  return { source: 'clash', columns: CLASH_DATASET_COLUMNS, rows, fingerprint: `clash:${state.clashRunSeq}:${rows.length}:${reviews}:${groups}` };
}
