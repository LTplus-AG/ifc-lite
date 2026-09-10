/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { sameCompanionParts, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type ViewerState } from '@/store';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import type { AppearancePlan } from './planner-types';
import type { AppearancePreviewParts } from './preview';
import { occurrenceSourceMesh } from './occurrence-source-mesh';
import { isTypeVisible } from '@/store/typeVisibilityFilter';

export function companionHiddenNow(globalId: number, state = useViewerStore.getState()): boolean {
  const ref = state.resolveGlobalIdFromModels(globalId);
  if (!ref) return false;
  const model = state.models.get(ref.modelId);
  if (!model?.ifcDataStore) return false;
  return model.visible === false || !isTypeVisible(model.ifcDataStore.entities.getTypeName(ref.expressId), state.typeVisibility);
}

/** Original native item identity proves precisely which companion is removed.
 * Keep the live wrappers so Undo retains all existing viewer metadata. */
export function bindCompanionPreview(state: ViewerState, renderer: Renderer, modelId: string,
  plan: AppearancePlan): AppearancePreviewParts[] {
  const scene = renderer.getScene();
  const place = scene.placeAppearanceSource?.bind(scene);
  const owners = new Map<number, NonNullable<AppearancePlan['conversions']>[number]>();
  const model = state.models.get(modelId), frame = placementFrameKey(state);
  const validate = () => {
    const current = useViewerStore.getState();
    if (current.models.get(modelId) !== model || current.modelPlacement !== state.modelPlacement
      || current.levelDisplayMode !== state.levelDisplayMode || current.typeVisibility !== state.typeVisibility || placementFrameKey(current) !== frame) {
      throw new Error('The opening companion placement changed. Refresh the preview.');
    }
  };
  const parts = new Map<number, ReturnType<typeof occurrenceSourceMesh>[]>();
  const targets = new Set(plan.items.map(item => item.productId));
  for (const conversion of plan.conversions ?? []) for (const mesh of conversion.sourceRemovedMeshes ?? []) {
    if (!Number.isSafeInteger(mesh.express_id) || mesh.express_id <= 0 || targets.has(mesh.express_id)
      || !Number.isSafeInteger(mesh.geometry_item_id) || mesh.geometry_item_id <= 0) throw new Error('Invalid companion native identity.');
    const previous = owners.get(mesh.express_id);
    if (previous && previous !== conversion) throw new Error('Companion belongs to more than one appearance conversion.');
    owners.set(mesh.express_id, conversion);
    const native = occurrenceSourceMesh(state, modelId, { ...conversion,
      productId: mesh.express_id, sourceGeometryItemId: mesh.geometry_item_id,
      sourcePositions: mesh.positions, sourceNormals: mesh.normals, sourceIndices: mesh.indices,
      sourceColor: [Math.fround(mesh.color[0]), Math.fround(mesh.color[1]), Math.fround(mesh.color[2]), Math.fround(mesh.color[3])], sourceOrigin: mesh.origin ?? [0, 0, 0], sourceRemovedMeshes: undefined });
    const list = parts.get(mesh.express_id) ?? [];
    if (list.some(part => part.geometryItemId === native.geometryItemId)) throw new Error('Duplicate companion item provenance.');
    if (!place) throw new Error('The renderer does not support canonical companion geometry.');
    list.push(place(native)); parts.set(mesh.express_id, list);
  }
  return [...parts].map(([owner, expected]) => {
    if (!place) throw new Error('The renderer does not support canonical companion geometry.');
    const globalId = state.toGlobalId(modelId, owner);
    const resident = scene.getMeshDataPieces(globalId);
    const hidden = companionHiddenNow(globalId, state);
    const originals = resident ?? (hidden ? model?.geometryResult?.meshes.filter(part => part.expressId === globalId)
      .map(part => place({ ...part, modelIndex: expected[0].modelIndex })) : undefined);
    if (scene.isInstancedEntity(globalId) || !originals || !sameCompanionParts(originals, expected.map((part, index) => ({
      ...part,
      // Native MeshData JSON omits this pre-placement metadata. Both compared
      // position arrays already contain the canonical placed geometry; retain
      // the live metadata unchanged for restoration instead of applying it twice.
      localToWorld: originals[index]?.localToWorld,
    })))) {
      throw new Error('Opening companion geometry changed. Refresh the appearance preview.');
    }
    return { globalId, modelIndex: expected[0].modelIndex!, parts: [], companionOriginals: originals, companionHidden: !resident && hidden ? true : undefined, validate };
  });
}
