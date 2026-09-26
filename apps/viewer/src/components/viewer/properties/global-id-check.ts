/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one GlobalId rule for every inline editor that can write IfcRoot's
 * GlobalId (the attribute editor and the Raw STEP row, #5872): 22 characters
 * of the IFC base64 alphabet (IfcGloballyUniqueId), not already carried by
 * another element of the same model.
 */

import type { TranslationKey } from '@/i18n';
import { useViewerStore } from '@/store';

const IFC_GUID = /^[0-9A-Za-z_$]{22}$/;

/**
 * Why `value` cannot be written as `entityId`'s GlobalId, or null when it can.
 * `globalIdOwner` returns the expressId already carrying a GlobalId in the
 * model, or a non-positive number when none does.
 */
export function globalIdProblem(
  value: unknown,
  entityId: number,
  globalIdOwner: (guid: string) => number,
): TranslationKey | null {
  if (typeof value !== 'string' || !IFC_GUID.test(value)) return 'properties.panel.attributeEditor.invalidGlobalId';
  const owner = globalIdOwner(value);
  return owner > 0 && owner !== entityId ? 'properties.panel.attributeEditor.duplicateGlobalId' : null;
}

/**
 * GlobalId → expressId lookup over `modelId` as edited: session edits count
 * (a GUID another element was just given is taken; a GUID an element was
 * just moved off is free), then the parsed index. The legacy single model is
 * the fallback store.
 */
export function modelGlobalIdOwner(modelId: string): (guid: string) => number {
  const state = useViewerStore.getState();
  const entities = state.models.get(modelId)?.ifcDataStore?.entities ?? state.ifcDataStore?.entities;
  const storeModelId = modelId === 'legacy' ? '__legacy__' : modelId;
  const view = state.mutationViews.get(storeModelId) ?? state.mutationViews.get(modelId);
  const parsedGuid = (id: number): string | undefined => entities?.getGlobalId?.(id) || undefined;
  if (!view) return (guid) => entities?.getExpressIdByGlobalId?.(guid) ?? -1;

  /** The GlobalId `id` carries now: a positional or attribute edit, else its authored or parsed value. */
  const effectiveGuid = (id: number): string | undefined => {
    const positional = view.getPositionalMutationsForEntity(id)?.get(0);
    if (typeof positional === 'string') return positional;
    const edited = view.getAttributeMutationsForEntity(id).find((m) => m.name === 'GlobalId')?.value;
    if (edited !== undefined) return edited;
    const created = view.getNewEntity(id)?.attributes[0];
    return typeof created === 'string' ? created : parsedGuid(id);
  };
  // Every entity whose GlobalId an edit may have changed: attribute edits,
  // live positional edits (all on the undo stack), and created entities.
  const edited = new Set<number>(view.getAttributeMutationsByEntity().keys());
  for (const m of state.undoStacks.get(storeModelId) ?? state.undoStacks.get(modelId) ?? []) if (m.type === 'UPDATE_POSITIONAL_ATTRIBUTE') edited.add(m.entityId);
  for (const e of view.getNewEntities()) edited.add(e.expressId);

  return (guid) => {
    for (const id of edited) if (!view.isDeleted(id) && effectiveGuid(id) === guid) return id;
    const parsed = entities?.getExpressIdByGlobalId?.(guid) ?? -1;
    return parsed > 0 && !view.isDeleted(parsed) && effectiveGuid(parsed) === guid ? parsed : -1;
  };
}
