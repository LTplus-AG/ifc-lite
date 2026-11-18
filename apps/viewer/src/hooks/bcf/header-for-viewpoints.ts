/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BCFViewpoint, BCFHeaderFile } from '@ifc-lite/bcf';
import { useViewerStore } from '@/store';
import { globalIdToExpressId as lookup } from '../bcfIdLookup';
import { deriveHeaderFiles } from '../bcfHeaderFiles';
/** Native provenance union: exact models, live model-qualified selection, component GUIDs, then single-model fallback. */
export function headerFilesForNativeViewpoints(viewpoints: readonly BCFViewpoint[], date?: string, exactModelIds?: readonly string[]): BCFHeaderFile[] {
  const state = useViewerStore.getState(), { models, ifcDataStore } = state;
  const globalIdToExpressId = (guid: string) => lookup(guid, models, ifcDataStore);
  const modelIds = new Set(exactModelIds);

  // Primary source: the live selection's model ids. A topic is created from
  // the current selection, and the selection knows each element's model
  // exactly. Resolving component GlobalIds instead would lose a model whose
  // elements share GlobalIds with another loaded model (revision
  // federations), collapsing every component onto the first match.
  const selected = useViewerStore.getState().selectedEntitiesSet;
  for (const key of selected) {
    const modelId = key.slice(0, key.lastIndexOf(':'));
    if (modelId) modelIds.add(modelId);
  }

  // Also union any model referenced by the viewpoint components but not the
  // live selection (e.g. hidden/coloured components, or a restored viewpoint).
  for (const vp of viewpoints) {
    const components: { ifcGuid?: string }[] = [
      ...(vp.components?.selection ?? []),
      ...(vp.components?.visibility?.exceptions ?? []),
      ...(vp.components?.coloring?.flatMap((c) => c.components) ?? []),
    ];
    for (const comp of components) {
      if (!comp.ifcGuid) continue;
      const resolved = globalIdToExpressId(comp.ifcGuid);
      if (resolved) modelIds.add(resolved.modelId);
    }
  }

  // Nothing resolved: record the single loaded model so a lone-model topic
  // still carries its provenance.
  if (modelIds.size === 0) {
    if (models.size === 1) {
      modelIds.add(models.keys().next().value!);
    } else if (models.size === 0 && ifcDataStore) {
      modelIds.add('legacy');
    }
  }

  return deriveHeaderFiles(modelIds, models, ifcDataStore, date);
}
