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
import { clashReviewKey, DEFAULT_CLASH_REVIEW_STATUS, type Clash, type ClashElementRef, type ClashReviewStatus, type ClashSeverity, type ClashStatus } from '@ifc-lite/clash';
import type { ViewerState } from '@/store';
import { effectiveStoreyId } from '@/lib/effective-storey';

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

export type ClashDatasetState = Pick<ViewerState, 'clashResult' | 'clashReviews' | 'clashGroups' | 'clashRunSeq' | 'models' | 'mutationViews' | 'resolveGlobalIdInModel'>;

/** Storey of an element, resolved like the CSV export: renderer id → local id → spatial hierarchy. */
function storeyOf(state: ClashDatasetState, ref: ClashElementRef): string {
  const hit = state.resolveGlobalIdInModel(ref.model, ref.ref);
  if (!hit) return '';
  const store = state.models.get(hit.modelId)?.ifcDataStore;
  const storeyId = store ? effectiveStoreyId(store, state.mutationViews.get(hit.modelId), hit.expressId) : undefined;
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

/**
 * What one clash row shows. The current result and a saved report (#6947)
 * both build their rows from this one list through `clashDatasetRow`, so a
 * column added here reaches both and neither can order its values differently.
 */
export interface ClashRowFacts {
  rule: string;
  severity: ClashSeverity;
  status: ClashStatus;
  review: ClashReviewStatus;
  typeA: string;
  typeB: string;
  modelA: string;
  modelB: string;
  storey: string;
  distance: number | null;
  group: string;
}

/** One dataset row in `CLASH_DATASET_COLUMNS` order. `ids` are renderer ids; a saved report passes none. */
export function clashDatasetRow(facts: ClashRowFacts, ids: ArrayLike<number>): ChartDatasetRow {
  const { typeA, typeB } = facts;
  return {
    ids,
    values: [
      facts.rule,
      facts.severity,
      facts.status,
      facts.review,
      typeA,
      typeB,
      typeA <= typeB ? `${typeA} vs ${typeB}` : `${typeB} vs ${typeA}`,
      facts.modelA,
      facts.modelB,
      facts.storey,
      facts.distance,
      facts.group,
    ],
  };
}

/** Clash id to the title of the group it is in, for the grouping the panel currently shows. */
export function clashGroupTitles(state: Pick<ClashDatasetState, 'clashGroups'>): Map<string, string> {
  const groupOf = new Map<string, string>();
  for (const group of state.clashGroups ?? []) for (const member of group.members) groupOf.set(member.id, group.title);
  return groupOf;
}

/** The row facts of one clash of the current result, read from the live store. */
export function liveClashFacts(state: ClashDatasetState, clash: Clash, groupOf: ReadonlyMap<string, string>): ClashRowFacts {
  const modelName = (id: string): string => state.models.get(id)?.name ?? id;
  return {
    rule: clash.rule,
    severity: clash.severity,
    status: clash.status,
    review: state.clashReviews.get(clashReviewKey(clash))?.status ?? DEFAULT_CLASH_REVIEW_STATUS,
    typeA: clash.a.tag,
    typeB: clash.b.tag,
    modelA: modelName(clash.a.model),
    modelB: modelName(clash.b.model),
    storey: storeyOf(state, clash.a),
    distance: clash.distance,
    group: groupOf.get(clash.id) ?? '',
  };
}

export function buildClashDataset(state: ClashDatasetState): ChartDataset {
  const result = state.clashResult;
  const rows: ChartDatasetRow[] = [];
  let groupOf = new Map<string, string>();
  if (result) {
    groupOf = clashGroupTitles(state);
    for (const clash of result.clashes) rows.push(clashDatasetRow(liveClashFacts(state, clash, groupOf), [clash.a.ref, clash.b.ref]));
  }
  // Reviews and groups change without a new run, so their CONTENT is part of
  // the identity: a status edit keeps `clashReviews.size`, and a manual
  // regroup keeps the row count, yet both move rows between buckets. A
  // fingerprint that missed them let a selected top-N "Other" bucket stay
  // live after its members had been regrouped away (#4833).
  const reviews = fingerprintStrings([...state.clashReviews].map(([key, review]) => `${key}=${review.status}`).sort());
  const groups = fingerprintStrings([...groupOf].map(([id, title]) => `${id}=${title}`).sort());
  const storeyColumn = CLASH_DATASET_COLUMNS.findIndex((column) => column.id === CLASH_COLUMNS.storey);
  const storeys = fingerprintStrings(rows.map((row) => String(row.values[storeyColumn])));
  return { source: 'clash', columns: CLASH_DATASET_COLUMNS, rows, fingerprint: `clash:${state.clashRunSeq}:${rows.length}:${reviews}:${groups}:${storeys}` };
}
