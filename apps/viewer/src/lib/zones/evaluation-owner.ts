/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import type { ElementAABB } from './types';
/** #7322: ownership of the actual native Scene evaluation, never inferred from a timestamp. */
const owners = new WeakMap<ViewerState['zoneAssignments'], { id: string; signature: string; scene: unknown; bounds: string }>();
function signature(state: ViewerState) {
  return { sets: JSON.stringify(state.zoneSets), tick: state.geometryUpdateTick, geometry: state.geometryContentVersion,
    models: [...state.models].map(([id, model]) => ({ id, model, store: model.ifcDataStore, source: model.ifcDataStore?.source,
      geometry: model.geometryResult, hash: model.sourceContentHash, fingerprint: model.sourceFingerprint,
      coordinates: JSON.stringify(model.geometryResult?.coordinateInfo), alignment: model.federationAlignmentStatus,
      view: state.mutationViews.get(id), revision: state.mutationViews.get(id)?.getMutationRevision() })) };
}
const savedOwners = new WeakMap<ViewerState['zoneAssignments'], ReturnType<typeof signature>>();
export function recordZoneEvaluationOwner(state: ViewerState, elements: ElementAABB[]): void {
  if (elements.length > 10000 || state.zoneSets.length > 10) return;
  const current = signature(state);
  savedOwners.set(state.zoneAssignments, current);
  owners.set(state.zoneAssignments, { id: crypto.randomUUID(), signature: JSON.stringify([...state.zoneAssignments]), scene: getGlobalRenderer()?.getScene(), bounds: JSON.stringify(elements) });
}
export function zoneEvaluationIsCurrent(state: ViewerState, initializingModel?: string): boolean {
  const owner = owners.get(state.zoneAssignments), saved = savedOwners.get(state.zoneAssignments);
  const scene = getGlobalRenderer()?.getScene();
  if (!owner || !saved || !scene || owner.scene !== scene || owner.signature !== JSON.stringify([...state.zoneAssignments])) return false;
  const next = signature(state);
  if (saved.sets !== next.sets || saved.tick !== next.tick || saved.geometry !== next.geometry || saved.models.length !== next.models.length
    || saved.models.some((row, index) => Object.keys(row).some(key => {
      if ((key === 'view' || key === 'revision') && row.id === initializingModel && !row.view && !state.mutationViews.get(row.id)?.getEffectiveChanges().length) return false;
      return row[key as keyof typeof row] !== next.models[index][key as keyof typeof row];
    }))) return false;
  const elements: ElementAABB[] = [];
  for (const globalId of scene.getAllMeshDataExpressIds()) {
    if (elements.length > 10000) return false;
    const bounds = scene.getEntityBoundingBox(globalId); if (!bounds) continue;
    elements.push({ globalId, min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] });
  }
  return JSON.stringify(elements) === owner.bounds;
}

/** Identity belongs to an actual completed native evaluation, not to equivalent later inputs. */
export function currentZoneEvaluationIdentity(state: ViewerState, initializingModel?: string): string | null {
  return zoneEvaluationIsCurrent(state, initializingModel) ? owners.get(state.zoneAssignments)?.id ?? null : null;
}
