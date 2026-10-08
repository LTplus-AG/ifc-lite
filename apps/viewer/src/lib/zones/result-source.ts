/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { captureAnalysisStamp, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import type { ZoneSet } from './types';
import type { ZoneApportionmentEntry } from './apportionment-cache';

export interface ZoneCachedSource {
  modelId: string | null;
  modelName: string | null;
  legacy: boolean;
  GlobalId: string | null;
  Name: string | null;
  IfcClass: string | null;
  stamp: AnalysisStamp;
}
interface ZoneResultInputs {
  zoneSetName: string;
  stamp: AnalysisStamp;
  rows: ReadonlyMap<number, ZoneCachedSource>;
}
export interface ZoneResultSource {
  zoneSetName: string;
  stamp: AnalysisStamp;
  incremental: boolean;
  /** A null member was retained from a cache without execution provenance. */
  rows: ReadonlyMap<number, ZoneCachedSource | null>;
}
const sources = new WeakMap<ZoneApportionmentEntry, ZoneResultSource>();

/** Capture the actual native inputs, before clipping; never borrow a later model picker (#7204). */
export function captureZoneResultInputs(zoneSet: ZoneSet, ids: readonly number[]): ZoneResultInputs {
  const state = useViewerStore.getState();
  const stamp = captureAnalysisStamp(true);
  return { zoneSetName: zoneSet.name, stamp, rows: new Map<number, ZoneCachedSource>(ids.map(id => {
    const ref = state.resolveGlobalIdFromModels(id);
    const model = ref ? state.models.get(ref.modelId) : undefined;
    // The native single-model fallback uses expressId === globalId, with no federation arithmetic.
    const legacy = state.models.size === 0 && state.ifcDataStore !== null;
    const entities = (legacy ? state.ifcDataStore : model?.ifcDataStore)?.entities;
    const localId = legacy ? id : ref?.expressId;
    return [id, { modelId: model?.id ?? null, modelName: model?.name ?? null, legacy,
      GlobalId: localId === undefined ? null : entities?.getGlobalId(localId) || null,
      Name: localId === undefined ? null : entities?.getName(localId) || null,
      IfcClass: localId === undefined ? null : entities?.getTypeName(localId) || null, stamp }];
  })) };
}

/** Retained older rows keep their own identity/stamp, including unknown origins. */
export function recordZoneResultSource(entry: ZoneApportionmentEntry, inputs: ZoneResultInputs,
  incremental: boolean, previous?: ZoneApportionmentEntry): ZoneApportionmentEntry {
  const prior = previous ? sources.get(previous) : undefined;
  sources.set(entry, { zoneSetName: inputs.zoneSetName, stamp: inputs.stamp, incremental,
    rows: new Map<number, ZoneCachedSource | null>([...entry.byElement.keys(), ...entry.refused.keys()].map(id =>
      [id, inputs.rows.get(id) ?? prior?.rows.get(id) ?? null])) });
  return entry;
}

export function zoneResultSource(entry: ZoneApportionmentEntry): ZoneResultSource | null {
  return sources.get(entry) ?? null;
}
