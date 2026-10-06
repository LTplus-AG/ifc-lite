/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which model and IFC entity a deviation scan asset belongs to (#6872,
 * #6833, #6887). The asset's federated global id is resolved against the
 * federation it was read from, so the model AND its entity come from one
 * lookup and cannot disagree. Not `resolveEntityRef`: its first-model
 * fallback would name a model for an id no model owns, and not the readback's
 * model index, which streamed scans did not always carry. Anything that does
 * not resolve stays null rather than guessed.
 */

import type { ViewerState } from '@/store';

export interface DeviationAssetIdentity {
  modelId: string | null;
  modelName: string | null;
  expressId: number | null;
  globalId: string | null;
  name: string | null;
  ifcClass: string | null;
}

export function deviationAssetIdentities(
  assets: readonly { expressId: number }[],
  source: Pick<ViewerState, 'models' | 'resolveGlobalIdFromModels'>,
): DeviationAssetIdentity[] {
  return assets.map((asset) => {
    const ref = source.resolveGlobalIdFromModels(asset.expressId);
    const model = ref ? source.models.get(ref.modelId) : undefined;
    const entities = model?.ifcDataStore?.entities;
    return {
      modelId: model && ref ? ref.modelId : null,
      modelName: model?.name ?? null,
      expressId: entities && ref ? ref.expressId : null,
      globalId: (ref && entities?.getGlobalId(ref.expressId)) || null,
      name: (ref && entities?.getName(ref.expressId)) || null,
      ifcClass: (ref && entities?.getTypeName(ref.expressId)) || null,
    };
  });
}
