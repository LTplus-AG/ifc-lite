/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { structuralCounterparts, type StructuralExtraction, type StructuralMemberInfo } from '@ifc-lite/parser';

type StructuralRecordInfo = StructuralExtraction[Exclude<keyof StructuralExtraction, 'hasStructural' | 'loadsTruncated'>][number];
/** A read-model record with its EXPRESS type (result groups and analysis models carry none of their own). */
export interface StructuralRecord { type: string; info: StructuralRecordInfo; member: boolean }

const indexes = new WeakMap<StructuralExtraction, { byId: Map<number, StructuralRecord>; byGuid: Map<string, StructuralRecord[]> }>();
/** Every record of the extraction by expressId and GlobalId, built once per extraction: the panel asks on every selection. */
function indexOf(data: StructuralExtraction) {
  let index = indexes.get(data);
  if (index) return index;
  index = { byId: new Map(), byGuid: new Map() };
  const add = (rows: readonly StructuralRecordInfo[], type: string | null, member = false) => {
    for (const info of rows) {
      const record = { type: type ?? (info as { type: string }).type, info, member };
      if (!index!.byId.has(info.expressId)) index!.byId.set(info.expressId, record);
      index!.byGuid.set(info.globalId, [...(index!.byGuid.get(info.globalId) ?? []), record]);
    }
  };
  add(data.members, null, true);
  add(data.connections, null);
  add(data.activities, null);
  add(data.loadGroups, null);
  add(data.resultGroups, 'IfcStructuralResultGroup');
  add(data.analysisModels, 'IfcStructuralAnalysisModel');
  indexes.set(data, index);
  return index;
}

/**
 * The read-model record a selection names, from any structural collection: by
 * local express id, else by a GlobalId that is unique among the records `keep`
 * admits.
 */
export function structuralRecord(data: StructuralExtraction, expressId: number | null, globalId: string | null | undefined,
  keep: (record: StructuralRecord) => boolean = () => true): StructuralRecord | null {
  const index = indexOf(data);
  if (expressId !== null && expressId > 0) {
    const record = index.byId.get(expressId);
    return record && keep(record) ? record : null;
  }
  const candidates = globalId ? (index.byGuid.get(globalId) ?? []).filter(keep) : [];
  return candidates.length === 1 ? candidates[0] : null;
}

/** Native structural member selection contract, shared with evidence (#7195). */
export function selectedStructuralMember(data: StructuralExtraction | null, expressId: number | null,
  globalId: string | null | undefined): StructuralMemberInfo | null {
  if (!data) return null;
  return (structuralRecord(data, expressId, globalId, (record) => record.member)?.info as StructuralMemberInfo | undefined) ?? null;
}

/**
 * What StructuralCard shows for a selection: the structural record it names
 * (member, connection, activity, load group or case, result group, analysis
 * model), the member when it is one, and the physical-to-analytical
 * counterparts (#9668), or null when the card renders nothing. The panel's
 * separator gate asks the same function. Counterparts are model-local express
 * ids, so a GUID-only selection gets none.
 */
export function structuralCardSubject(data: StructuralExtraction | null, expressId: number | null,
  globalId: string | null | undefined) {
  if (!data) return null;
  const record = structuralRecord(data, expressId, globalId);
  const member = selectedStructuralMember(data, expressId, globalId);
  const counterparts = expressId !== null && expressId > 0 ? structuralCounterparts(data, expressId) : null;
  return record || member || counterparts ? { record, member, counterparts } : null;
}

/** Native cross-links contain GUIDs only: duplicate or missing targets cannot be resolved honestly. */
export function structuralRelatedRows<T extends { globalId: string }>(rows: readonly T[], ids: readonly string[]) {
  const byId = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    if (byId.has(row.globalId)) duplicates.add(row.globalId);
    else byId.set(row.globalId, row);
  }
  const resolved: T[] = [];
  let unavailable = false;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || duplicates.has(id)) unavailable = true;
    else resolved.push(row);
  }
  return { rows: resolved, unavailable };
}
