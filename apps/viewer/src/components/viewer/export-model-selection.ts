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
 *
 * The two scopes draw the absent-store line differently, and both follow what
 * happens if the export runs. `ensureModelExportReady` returns
 * `model.ifcDataStore` as it is: it hydrates NOTHING, so a store that is
 * absent at this question is absent at export time too. The merge then has
 * nothing of that model to write and `buildMergeInputs` skips it, so a merge
 * needs one store it can actually write — counting an absent one as writable
 * offered the export for a `.3dm` beside a still-loading model and then ran
 * the merge over zero inputs, which `MergedExporter`'s own precondition
 * refused as `requires at least one model`: an internal invariant where the
 * dialog should have said it had no records. The single path keeps main's
 * answer, because there the absent store is refused on the way with a
 * sentence of its own ("Model data is unavailable for export").
 */
export function canWriteIfcFromStores(
  models: ReadonlyMap<string, FederatedModel>,
  selected: { readonly ifcDataStore?: IfcDataStore | null } | undefined,
  scope: 'single' | 'merged',
  targetIsIfcx: boolean,
): boolean {
  if (targetIsIfcx) return true;
  if (scope === 'merged') {
    return exportableModels(models).some((model) => stepSkipReason(model.ifcDataStore) === null);
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
 * The single path for that same room is unchanged from main, and unchanged is
 * all this claims: it falls through to `StepExporter` over the room store. On
 * a reconstructed room that writes the tabular reader's own bytes, which is
 * the bad file this gate exists to prevent — #10085, filed rather than fixed
 * by widening the gate, because refusing the room here would swap a bad file
 * for a silent skip. The fix is a third reason value and a sentence.
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
