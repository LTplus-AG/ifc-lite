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

/** GlobalId → expressId lookup over `modelId`'s parsed entities (the legacy single model as fallback). */
export function modelGlobalIdOwner(modelId: string): (guid: string) => number {
  const state = useViewerStore.getState();
  const entities = state.models.get(modelId)?.ifcDataStore?.entities ?? state.ifcDataStore?.entities;
  return (guid) => entities?.getExpressIdByGlobalId?.(guid) ?? -1;
}
