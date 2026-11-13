/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Merge-input assembly for `ExportDialog`'s merged STEP branch, plus the one
 * thing the dialog could not say before: which models the merge left out.
 *
 * A merged export writes STEP records, so it skips a model that has no store
 * at all and one whose store is tabular with no records behind it (a `.3dm`,
 * an IFCX: the reader handed over finished tables, never records). A shared
 * room is tabular too and is NOT skipped, because its portable STEP source
 * holds the records — `stepSkipReason` draws that line, and
 * `canWriteIfcFromStores` allows the merge as long as ONE participant is
 * writable. The skip itself is correct; reporting only the included count was
 * not, because a partial federation then downloads as "the merged file" with
 * nothing said about the missing model.
 */

import type { MergeModelInput } from '@ifc-lite/export';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import type { UseTranslationResult } from '@/i18n/useTranslation';
import { exportableModels } from '@/lib/export/capture-export';
import { stepSkipReason, type StepSkipReason } from './export-model-selection';
import { roomMergeInput } from '@/lib/collab/room-merged-export';
import type { RoomStepExportSource } from '@/lib/collab/room-step-export';

export interface MergeSkip {
  name: string;
  reason: StepSkipReason;
}

export interface HydratedMergeModel {
  model: { id: string; name: string };
  dataStore: IfcDataStore | null | undefined;
}

export interface MergeInputs {
  inputs: MergeModelInput[];
  portableByModel: Map<string, RoomStepExportSource>;
  skipped: MergeSkip[];
}

/**
 * The models a merged export will leave out, as far as the dialog says before
 * it runs: only a STATED tabular marker, never an absent store.
 *
 * A store-less model IS still skipped, and {@link buildMergeInputs} names it
 * in the result message. It is left out of this note because an absent store
 * is usually a load still in flight, which would make the line appear and
 * vanish while nothing about the model had been decided. The export gate
 * refuses a merge with no writable store at all
 * (`canWriteIfcFromStores`), so the dialog is never silent about having
 * nothing to write; what it does not do is name a model mid-load.
 */
export function statedMergeSkips(models: ReadonlyMap<string, FederatedModel>): MergeSkip[] {
  return exportableModels(models)
    .filter(model => stepSkipReason(model.ifcDataStore) === 'noRecords')
    .map(model => ({ name: model.name, reason: 'noRecords' as const }));
}

/** Assemble one `MergeModelInput` per writable model, and name the rest. */
export function buildMergeInputs(
  hydrated: readonly HydratedMergeModel[],
  options: {
    applyMutations: boolean;
    getMutationView: (modelId: string) => MutablePropertyView | null;
  },
): MergeInputs {
  const inputs: MergeModelInput[] = [];
  const portableByModel = new Map<string, RoomStepExportSource>();
  const skipped: MergeSkip[] = [];
  for (const { model, dataStore } of hydrated) {
    // Split so the store narrows: `stepSkipReason` answers for both cases, but
    // only the explicit absent-store guard tells the compiler so.
    if (!dataStore) { skipped.push({ name: model.name, reason: 'noData' }); continue; }
    const reason = stepSkipReason(dataStore);
    if (reason) { skipped.push({ name: model.name, reason }); continue; }
    const roomView = options.applyMutations ? (options.getMutationView(model.id) ?? undefined) : undefined;
    const { input, portable } = roomMergeInput({
      id: model.id, name: model.name, store: dataStore,
      roomView, applyMutations: options.applyMutations,
    });
    if (portable) portableByModel.set(model.id, portable);
    inputs.push(input);
  }
  return { inputs, portableByModel, skipped };
}

/**
 * One complete sentence per reason, never an assembled fragment (the i18n
 * brief): translators control the wording around the model names, and the
 * names themselves are display values. Empty string when nothing was
 * skipped, so the all-STEP message stays exactly what it was.
 */
export function mergeSkipNotice(skipped: readonly MergeSkip[], t: UseTranslationResult['t']): string {
  const reasons: readonly StepSkipReason[] = ['noRecords', 'noData'];
  return reasons
    .map((reason) => {
      const names = skipped.filter(skip => skip.reason === reason).map(skip => skip.name);
      return names.length === 0 ? '' : t(`exportDialog.mergeSkipped.${reason}`, { models: names.join(', ') });
    })
    .filter(Boolean)
    .join(' ');
}
