/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Comparison impact (#6921): which changed elements of a native comparison
 * are referenced by the other analyses currently loaded — clash findings,
 * validation failures, list rows (with their native numeric column totals)
 * and BCF topics.
 *
 * Pure and deterministic. Membership is the only join: an element is
 * "touched" when the analysis names the SAME model and GlobalId the
 * comparison reported as added, deleted or modified (BCF topics carry no
 * model, so they join on GlobalId alone). Nothing here infers causality,
 * proximity or similarity; every number is copied from a native result.
 */

import { clashReviewKey, type ClashResult } from '@ifc-lite/clash';
import type { ValidationReport } from '@ifc-lite/ids';
import type { ListResult } from '@ifc-lite/lists';
import type { BCFComponent, BCFTopic } from '@ifc-lite/bcf';
import type { DiffChangeKind, DiffEntry } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints';

export type ImpactSide = 'base' | 'head';
export type ChangedState = 'added' | 'deleted' | 'modified';
export type ImpactSourceStatus = 'available' | 'unavailable' | 'stale';
export type ImpactSource = 'clash' | 'validation' | 'list' | 'bcf';

export interface ChangedElementRef {
  globalId: string;
  side: ImpactSide;
  state: ChangedState;
  changeKinds: DiffChangeKind[];
  ifcType: string;
}

export type ImpactRow =
  | { kind: 'clash'; clashId: string; reviewKey: string; rule: string; status: string; severity: string;
    distance: number; changed: ChangedElementRef[]; elements: Array<{ globalId: string; side: ImpactSide | null; ifcType: string }> }
  | { kind: 'validation'; side: ImpactSide; specificationId: string; specificationName: string;
    failedRequirements: string[]; changed: ChangedElementRef }
  | { kind: 'list'; listId: string; listName: string; touchedRows: number; totalRows: number;
    columns: Array<{ label: string; touchedSum: number; totalSum: number }>; changed: ChangedElementRef[] }
  | { kind: 'bcf'; topicGuid: string; title: string; topicStatus: string | null; changed: ChangedElementRef[] };

export interface CompareImpact {
  /** Added + deleted + modified diff entries whose GlobalId could be resolved. */
  changedElements: number;
  /** Changed entries with no resolvable GlobalId (never joined, never guessed). */
  unresolvedChanges: number;
  sources: Record<ImpactSource, ImpactSourceStatus>;
  /** Exact counts of impacted findings/rows per source, independent of the row bound. */
  totals: Record<ImpactSource, number>;
  rows: ImpactRow[];
  totalRows: number;
  rowsTruncated: boolean;
}

export interface ImpactInput {
  baseModelId: string;
  headModelId: string;
  entries: readonly DiffEntry<CompareRef>[];
  /** GlobalId of one compared entity, read from the store the diff ran on. */
  globalIdOf: (modelId: string, localId: number) => string | undefined;
  clash?: { result: ClashResult; stale: boolean } | null;
  validation?: { report: ValidationReport; stale: boolean } | null;
  list?: { id: string; name: string; result: ListResult; stale: boolean } | null;
  bcfTopics?: readonly BCFTopic[] | null;
  rowLimit?: number;
}

const MAX_COLUMNS = 12;
const MAX_CHANGED_PER_ROW = 20;
const modelKey = (modelId: string, globalId: string) => `${modelId}\u0000${globalId}`;
/** A clash key is the GlobalId, suffixed `:<occurrence>` for a GPU-instanced occurrence. */
export const clashKeyGlobalId = (key: string) => key.length > 22 && key[22] === ':' ? key.slice(0, 22) : key;

function status(present: unknown, stale: boolean | undefined): ImpactSourceStatus {
  if (!present) return 'unavailable';
  return stale ? 'stale' : 'available';
}

/** Changed elements, per side, keyed by model + GlobalId and by GlobalId alone. */
function changedIndex(input: ImpactInput) {
  const byModel = new Map<string, ChangedElementRef>();
  const byGlobalId = new Map<string, ChangedElementRef[]>();
  let resolved = 0, unresolved = 0;
  const add = (entry: DiffEntry<CompareRef>, side: ImpactSide, ref: CompareRef | undefined, ifcType: string) => {
    if (!ref) return false;
    const globalId = input.globalIdOf(ref.modelId, ref.localId);
    if (!globalId) return false;
    const changed: ChangedElementRef = { globalId, side, state: entry.state as ChangedState, changeKinds: [...entry.changeKinds], ifcType };
    byModel.set(modelKey(ref.modelId, globalId), changed);
    const list = byGlobalId.get(globalId);
    if (list) list.push(changed); else byGlobalId.set(globalId, [changed]);
    return true;
  };
  for (const entry of input.entries) {
    if (entry.state === 'unchanged') continue;
    const baseOk = entry.state !== 'added' && add(entry, 'base', entry.base?.ref, entry.base?.ifcType ?? 'IfcProduct');
    const headOk = entry.state !== 'deleted' && add(entry, 'head', entry.head?.ref, entry.head?.ifcType ?? 'IfcProduct');
    if (baseOk || headOk) resolved++; else unresolved++;
  }
  return { byModel, byGlobalId, resolved, unresolved };
}

function clashRows(input: ImpactInput, index: ReturnType<typeof changedIndex>): ImpactRow[] {
  const rows: ImpactRow[] = [];
  const sideOf = (model: string): ImpactSide | null => model === input.baseModelId ? 'base' : model === input.headModelId ? 'head' : null;
  for (const clash of input.clash?.result.clashes ?? []) {
    const changed = [clash.a, clash.b].flatMap(ref => {
      const hit = index.byModel.get(modelKey(ref.model, clashKeyGlobalId(ref.key)));
      return hit ? [hit] : [];
    });
    if (changed.length === 0) continue;
    rows.push({ kind: 'clash', clashId: clash.id, reviewKey: clashReviewKey(clash), rule: clash.rule, status: clash.status,
      severity: clash.severity, distance: clash.distance, changed,
      elements: [clash.a, clash.b].map(ref => ({ globalId: clashKeyGlobalId(ref.key), side: sideOf(ref.model), ifcType: ref.tag })) });
  }
  return rows.sort((a, b) => a.kind === 'clash' && b.kind === 'clash' ? a.clashId.localeCompare(b.clashId) : 0);
}

function validationRows(input: ImpactInput, index: ReturnType<typeof changedIndex>): ImpactRow[] {
  const rows: ImpactRow[] = [];
  for (const spec of input.validation?.report.specificationResults ?? []) {
    for (const entity of spec.entityResults) {
      if (entity.passed || !entity.globalId) continue;
      const changed = index.byModel.get(modelKey(entity.modelId, entity.globalId));
      if (!changed) continue;
      rows.push({ kind: 'validation', side: changed.side, specificationId: spec.specification.id,
        specificationName: spec.specification.name, changed,
        failedRequirements: entity.requirementResults.filter(r => r.status === 'fail').map(r => r.requirement.id).sort() });
    }
  }
  return rows;
}

function listRows(input: ImpactInput, index: ReturnType<typeof changedIndex>): ImpactRow[] {
  const list = input.list;
  if (!list) return [];
  const numeric = list.result.columns.map((column, i) => ({ i, label: column.label || column.propertyName }))
    .filter(({ i }) => list.result.rows.some(row => typeof row.values[i] === 'number')).slice(0, MAX_COLUMNS);
  const columns = numeric.map(({ label }) => ({ label, touchedSum: 0, totalSum: 0 }));
  const changed: ChangedElementRef[] = [];
  let touchedRows = 0;
  for (const row of list.result.rows) {
    const globalId = input.globalIdOf(row.modelId, row.entityId);
    const hit = globalId ? index.byModel.get(modelKey(row.modelId, globalId)) : undefined;
    if (hit) { touchedRows++; if (changed.length < MAX_CHANGED_PER_ROW) changed.push(hit); }
    numeric.forEach(({ i }, c) => {
      const value = row.values[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      columns[c].totalSum += value;
      if (hit) columns[c].touchedSum += value;
    });
  }
  if (touchedRows === 0) return [];
  return [{ kind: 'list', listId: list.id, listName: list.name, touchedRows, totalRows: list.result.rows.length, columns, changed }];
}

function topicComponents(topic: BCFTopic): BCFComponent[] {
  return topic.viewpoints.flatMap(vp => [...(vp.components?.selection ?? []),
    ...(vp.components?.coloring ?? []).flatMap(c => c.components),
    ...(vp.components?.visibility?.exceptions ?? [])]);
}

function bcfRows(input: ImpactInput, index: ReturnType<typeof changedIndex>): ImpactRow[] {
  const rows: ImpactRow[] = [];
  for (const topic of input.bcfTopics ?? []) {
    const seen = new Set<string>();
    const changed: ChangedElementRef[] = [];
    for (const component of topicComponents(topic)) {
      const guid = component.ifcGuid;
      if (!guid || seen.has(guid)) continue;
      seen.add(guid);
      for (const hit of index.byGlobalId.get(guid) ?? []) if (changed.length < MAX_CHANGED_PER_ROW) changed.push(hit);
    }
    if (changed.length > 0) rows.push({ kind: 'bcf', topicGuid: topic.guid, title: topic.title, topicStatus: topic.topicStatus ?? null, changed });
  }
  return rows.sort((a, b) => a.kind === 'bcf' && b.kind === 'bcf' ? a.topicGuid.localeCompare(b.topicGuid) : 0);
}

export function computeCompareImpact(input: ImpactInput): CompareImpact {
  const index = changedIndex(input);
  const bySource = {
    clash: clashRows(input, index),
    validation: validationRows(input, index),
    list: listRows(input, index),
    bcf: bcfRows(input, index),
  };
  const all = [...bySource.clash, ...bySource.validation, ...bySource.list, ...bySource.bcf];
  const limit = input.rowLimit ?? 100;
  return {
    // One per diff entry: a modified element is one change, not one per side.
    changedElements: index.resolved,
    unresolvedChanges: index.unresolved,
    sources: {
      clash: status(input.clash, input.clash?.stale),
      validation: status(input.validation, input.validation?.stale),
      list: status(input.list, input.list?.stale),
      bcf: status(input.bcfTopics, false),
    },
    totals: {
      clash: bySource.clash.length,
      validation: bySource.validation.length,
      // A list impact is counted in touched rows, not in impact rows.
      list: bySource.list.reduce((sum, row) => sum + (row.kind === 'list' ? row.touchedRows : 0), 0),
      bcf: bySource.bcf.length,
    },
    rows: all.slice(0, limit),
    totalRows: all.length,
    rowsTruncated: all.length > limit,
  };
}

/** Disclosed to the assistant and the panel alongside every impact section. */
export const IMPACT_LIMITATIONS = 'Impact joins analyses to changed elements by model and GlobalId membership only (BCF topics by GlobalId). '
  + 'It is computed against the analyses loaded at capture; an analysis marked stale was run before later edits. '
  + 'A touched finding is not proof that the change caused or fixed it. Unchanged elements and unresolved changes are never joined.';
