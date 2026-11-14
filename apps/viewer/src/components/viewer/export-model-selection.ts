/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { exportableModels } from '@/lib/export/capture-export';
import { roomSymbolicSource } from '@/lib/collab/room-symbolic-source';

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
 * Should the dialog offer this IFC export at all?
 *
 * Only a merged STEP export is gated here. The merge skips a tabular model the
 * way it skips one with no store (`buildMergeInputs`), so a `.3dm` or `.ifcx`
 * beside IFC models does not refuse the merge of the models beside it; the
 * merge needs ONE store it can write. `ensureModelExportReady` hydrates
 * nothing, so an absent store here is absent at export time too, and counting
 * it as writable would run the merge over zero inputs.
 *
 * A single-model export is always offered: `exportModelStep` refuses a store
 * with no STEP records itself, naming the model (#10045, #10099), and an IFCX
 * target reads the tables, so it can always write.
 */
export function canWriteIfcFromStores(
  models: ReadonlyMap<string, FederatedModel>,
  scope: 'single' | 'merged',
  targetIsIfcx: boolean,
): boolean {
  if (targetIsIfcx || scope === 'single') return true;
  return exportableModels(models).some((model) => stepSkipReason(model.ifcDataStore) === null);
}

/** Why a STEP export cannot write this store, or `null` when it can. */
export type StepSkipReason = 'noRecords' | 'noData';

/**
 * The dialog's copy of the "tabular means no STEP records" rule: the merged
 * gate above, the merged export's pre-export note and result message
 * (`export-merge-inputs.ts`), and the single-model hint all derive from it.
 * The export itself refuses through `stepExportSource` in
 * `lib/export/step-records.ts` (#10099), which checks the same rule on its
 * own, so a new non-STEP source kind is an edit in both places.
 *
 * Tabular is the reason to LOOK for records, not the refusal itself. A shared
 * room's store is tabular — the room is reconstructed from IFCX — and yet it
 * can carry a registered portable STEP source holding the very records a STEP
 * export needs; `exportModelStep` and `roomMergeInput` both reach for it
 * through `roomStepExportSource`. Asking for the source kind alone refused
 * every shared room, single and merged, which is what main exported.
 *
 * `roomSymbolicSource` asks whether a portable source is REGISTERED, not
 * whether `canExportRoomAsStep` currently accepts it. That is a choice, not a
 * limitation — `canExportRoomAsStep` answers without a `MutablePropertyView`
 * too. A room whose root set has moved past its source is deliberately let
 * through here and refused further down, where the merged path throws
 * `roomMergeInput`'s named "export it separately" rather than dropping the
 * model from the file without a word.
 *
 * It is also the cheap import: `room-symbolic-source.ts` imports only types,
 * while `room-step-export.ts` pulls `@ifc-lite/export`, `@ifc-lite/mutations`
 * and the placement-edit boot module onto the command-palette path.
 *
 * The single path for that same room is refused by `exportModelStep` when the
 * room has moved past its source (`StepRecordsUnavailableError('roomMoved')`,
 * #10099), so a reconstructed room no longer writes the reader's bytes.
 */
export function stepSkipReason(store: IfcDataStore | null | undefined): StepSkipReason | null {
  if (!store) return 'noData';
  if (store.sourceKind !== 'tabular') return null;
  return roomSymbolicSource(store) ? null : 'noRecords';
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
