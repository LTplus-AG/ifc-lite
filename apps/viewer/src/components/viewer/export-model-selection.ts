/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { exportableModels } from '@/lib/export/capture-export';
import { hasPortableStepRecords } from '@/lib/collab/room-step-export';

export interface ExportModelListItem {
  id: string;
  name: string;
  isDirty: boolean;
  schemaVersion: FederatedModel['schemaVersion'];
  /** What backs the model's store; see `stepSkipReason` for what `'tabular'` can still write. */
  sourceKind: IfcDataStore['sourceKind'];
  sourceSchema: FederatedModel['sourceSchema'];
}

type SelectedExportModel = FederatedModel | {
  id: '__legacy__';
  name: 'Current Model';
  ifcDataStore: IfcDataStore;
  geometryResult: GeometryResult;
  visible: true;
  collapsed: false;
  schemaVersion: FederatedModel['schemaVersion'];
  sourceSchema: undefined;
  // Stated rather than omitted: the legacy single-model path is reached only
  // by `loadFile` on an IFC source, so it can never carry LandXML records.
  // Leaving these off the branch forced every LandXML-aware caller to narrow
  // the union before it could ask (#4937).
  landXmlDocument: undefined;
  sourceFile: undefined;
};

export function listExportModels(
  models: ReadonlyMap<string, FederatedModel>,
  dirtyModels: ReadonlySet<string>,
  legacyStore: IfcDataStore | null,
): ExportModelListItem[] {
  const list = exportableModels(models).map((model) => ({
    id: model.id,
    name: model.name,
    isDirty: dirtyModels.has(model.id),
    schemaVersion: model.schemaVersion,
    sourceKind: model.ifcDataStore?.sourceKind,
    sourceSchema: model.sourceSchema,
  }));
  if (list.length === 0 && legacyStore) {
    list.push({
      id: '__legacy__',
      name: 'Current Model',
      isDirty: false,
      schemaVersion: legacyStore.schemaVersion,
      sourceKind: legacyStore.sourceKind,
      sourceSchema: undefined,
    });
  }
  return list;
}

/** Ion consumes STEP IFC, unlike the general export formats (#8947).
 * An existing federation must never fall back to its legacy active-store slot:
 * that could resurrect a capture which exportableModels deliberately omitted. */
export function listIonExportModels(
  models: ReadonlyMap<string, FederatedModel>,
  legacyStore: IfcDataStore | null,
): ExportModelListItem[] {
  return listExportModels(models, new Set(), models.size === 0 ? legacyStore : null)
    .filter(model => model.schemaVersion !== 'IFC5' && model.sourceKind !== 'tabular' && !model.sourceSchema
      && (model.id === '__legacy__' || models.get(model.id)?.ifcDataStore));
}

/**
 * Can this export write a full IFC file from the stores it would read?
 *
 * The merged and STEP branches read a store's `source` as STEP records, which
 * a tabular store has not got: a reader handed over finished tables, and
 * `source` holds that reader's own format (a `.3dm`). The IFCX branch reads
 * the tables instead, so an IFCX target is always allowed; anything else over
 * a tabular store with no records behind it would download an empty or
 * garbage file. Which stores have records behind them is `stepSkipReason`'s
 * question, not this one's.
 *
 * A merged export asks for ONE writable store, not all of them: it skips a
 * tabular model the way it skips one with no store, so a `.3dm` or `.ifcx`
 * sitting in the federation does not refuse the merge of the IFC models
 * beside it. A single-model export has only the selection to write.
 */
export function canWriteIfcFromStores(
  models: ReadonlyMap<string, FederatedModel>,
  selected: { readonly ifcDataStore?: IfcDataStore | null } | undefined,
  scope: 'single' | 'merged',
  targetIsIfcx: boolean,
): boolean {
  if (targetIsIfcx) return true;
  // An absent store is not a refusal: `ensureModelExportReady` hydrates one at
  // export time. Only a STATED tabular marker disqualifies a model, which is
  // why this asks for `noRecords` rather than for any skip reason at all.
  if (scope === 'merged') {
    return exportableModels(models).some((model) => stepSkipReason(model.ifcDataStore) !== 'noRecords');
  }
  return stepSkipReason(selected?.ifcDataStore) !== 'noRecords';
}

/** Why a STEP export cannot write this store, or `null` when it can. */
export type StepSkipReason = 'noRecords' | 'noData';

/**
 * The one place the "tabular means no STEP records" rule lives. Every caller
 * that drops a model from a STEP export, and every caller that reports the
 * drop, derives from this: the gate above, the merged export's pre-export
 * note, and its result message (`export-merge-inputs.ts`). A new non-STEP
 * source kind is then one edit, not three.
 *
 * Tabular is the reason to LOOK for records, not the refusal itself. A shared
 * room's store is tabular — the room is reconstructed from IFCX — and yet it
 * can carry a registered portable STEP source holding the very records a STEP
 * export needs; `exportModelStep` and `roomMergeInput` both reach for it
 * through `roomStepExportSource`. Asking for the source kind alone refused
 * every shared room, single and merged, which is what main exported.
 *
 * `hasPortableStepRecords` asks whether a portable source is REGISTERED, not
 * whether `canExportRoomAsStep` currently accepts it. A room whose root set has moved
 * past its source is a different answer with its own wording: the single path
 * falls back to the room store and the merged path throws
 * `roomMergeInput`'s "export it separately". Both are main's behaviour, and
 * folding them into a silent "no IFC records" skip would lose it.
 */
export function stepSkipReason(store: IfcDataStore | null | undefined): StepSkipReason | null {
  if (!store) return 'noData';
  if (store.sourceKind !== 'tabular') return null;
  return hasPortableStepRecords(store) ? null : 'noRecords';
}

export function resolveExportModel(
  models: ReadonlyMap<string, FederatedModel>,
  selectedModelId: string,
  legacyStore: IfcDataStore | null,
  legacyGeometry: GeometryResult | null,
): SelectedExportModel | undefined {
  if (selectedModelId !== '__legacy__' || !legacyStore || !legacyGeometry) {
    return models.get(selectedModelId);
  }
  return {
    id: '__legacy__',
    name: 'Current Model',
    ifcDataStore: legacyStore,
    geometryResult: legacyGeometry,
    visible: true,
    collapsed: false,
    schemaVersion: legacyStore.schemaVersion,
    sourceSchema: undefined,
    landXmlDocument: undefined,
    sourceFile: undefined,
  };
}
