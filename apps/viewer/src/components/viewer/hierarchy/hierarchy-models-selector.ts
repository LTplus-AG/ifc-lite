/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { collectMeshedIds } from '@/lib/object-count';

type Models = Map<string, FederatedModel>;

/** Which ids each geometry result meshes; one scan per result object. */
const meshedIdsByResult = new WeakMap<GeometryResult, Set<number>>();
function meshedIds(result: GeometryResult | null): Set<number> | null {
  if (!result) return null;
  let ids = meshedIdsByResult.get(result);
  if (!ids) meshedIdsByResult.set(result, ids = collectMeshedIds(result));
  return ids;
}

function sameIds(a: Set<number> | null, b: Set<number> | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Every model field except its geometry is identical, and the same ids have geometry. */
function sameForHierarchy(prev: Models, next: Models): boolean {
  if (prev.size !== next.size) return false;
  const prevEntries = [...prev];
  let i = 0;
  for (const [id, model] of next) {
    const [prevId, prevModel] = prevEntries[i++];
    if (prevId !== id) return false;
    if (prevModel === model) continue;
    const keys = new Set([...Object.keys(prevModel), ...Object.keys(model)]);
    for (const key of keys) {
      if (key === 'geometryResult' || key === 'preAlignment') continue;
      if (prevModel[key as keyof FederatedModel] !== model[key as keyof FederatedModel]) return false;
    }
    if (!sameIds(meshedIds(prevModel.geometryResult), meshedIds(model.geometryResult))) return false;
  }
  return true;
}

/**
 * `models` for the hierarchy, held at its previous identity across a geometry
 * update that changes nothing the tree shows (#6232 perf). A re-meshed
 * element swaps meshes but keeps its id, so re-rendering the panel and every
 * visible row for it is wasted work. The tree reads geometry only for WHICH
 * ids have it (and whether a model has geometry at all), and that is exactly
 * what is compared. A store selector, so an unchanged answer does not even
 * re-render the panel.
 */
export function createHierarchyModelsSelector(): (state: { models: Models }) => Models {
  let input: Models | null = null;
  let output: Models | null = null;
  return (state) => {
    const models = state.models;
    if (models === input) return output!;
    const reuse = output !== null && models.size > 0 && sameForHierarchy(output, models);
    input = models;
    if (!reuse) output = models;
    return output!;
  };
}

/** The legacy single-model geometry, which the tree reads only when no model is registered. */
export function selectLegacyHierarchyGeometry(state: { models: Models; geometryResult: GeometryResult | null }): GeometryResult | null {
  return state.models.size > 0 ? null : state.geometryResult;
}
