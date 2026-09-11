/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EdgeLockInput } from '@ifc-lite/renderer';
import { EDGE_LOCK_DEFAULTS } from '@/store/constants';
import { useEffect, useState } from 'react';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { resolveEntityRef, useViewerStore } from '@/store';
import { fromRenderTranslation, orthogonalAxis, constrainTranslation, subtractTranslation } from '@/lib/model-placement/translation';
import type { PlacementAnchor } from '@/lib/model-placement/state';

export type PickRole = 'source' | 'target' | null;

/** Uses the measurement tool's real mesh/scan snap path. Navigation remains
 * available on the other mouse buttons while left-click selects an anchor. */
export function useRepositionPicking(role: PickRole, finish: (role: PickRole) => void, onError: (message: string) => void, reference = '') {
  const [hover, setHover] = useState<PlacementAnchor | null>(null);
  const models = useViewerStore((state) => state.models);
  useEffect(() => {
    const renderer = getGlobalRenderer(), canvas = renderer?.getCanvas();
    if (!role || !renderer || !canvas) { setHover(null); return; }
    const state = useViewerStore.getState(), preview = state.modelPlacement.preview;
    if (!preview) return;
    const allowed = new Set<number>();
    const accepts = (id: string) => (role === 'source') === preview.before.has(id) && state.models.get(id)?.visible &&
      (role === 'source' || !reference || id === reference);
    for (const [id, model] of state.models) {
      if (!accepts(id)) continue;
      for (const mesh of model.geometryResult?.meshes ?? []) {
        if (mesh.entityIds) for (const entityId of mesh.entityIds) allowed.add(entityId);
        else allowed.add(mesh.expressId);
      }
      for (const cloud of model.geometryResult?.pointClouds ?? []) allowed.add(cloud.expressId);
    }
    for (const id of renderer.getScene().getInstancedEntityIds()) if (accepts(resolveEntityRef(id).modelId)) allowed.add(id);
    let edgeLock: EdgeLockInput = { edge: null, meshExpressId: null, lockStrength: 0 };
    let lastRevision = state.modelPlacement.revision;
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = 'crosshair';
    const pick = (event: PointerEvent): PlacementAnchor | null => {
      const current = useViewerStore.getState();
      if (!current.modelPlacement.preview) return null;
      if (!current.snapEnabled || (role === 'source' && lastRevision !== current.modelPlacement.revision)) {
        edgeLock = { edge: null, meshExpressId: null, lockStrength: 0 };
      }
      lastRevision = current.modelPlacement.revision;
      const rect = canvas.getBoundingClientRect();
      const isolatedIds = current.isolatedEntities === null ? allowed
        : new Set([...allowed].filter((id) => current.isolatedEntities?.has(id)));
      const result = renderer.raycastSceneMagnetic(event.clientX - rect.left, event.clientY - rect.top,
        edgeLock, {
          hiddenIds: current.hiddenEntities, isolatedIds,
          snapOptions: { snapToVertices: current.snapEnabled, snapToEdges: current.snapEnabled,
            snapToFaces: current.snapEnabled, snapToPointClouds: true, screenSnapRadius: 12 },
        });
      if (result.edgeLock.shouldRelease) edgeLock = { edge: null, meshExpressId: null, lockStrength: 0 };
      else if (result.edgeLock.shouldLock && result.edgeLock.edge) edgeLock = {
        edge: result.edgeLock.edge, meshExpressId: result.edgeLock.meshExpressId, lockStrength: EDGE_LOCK_DEFAULTS.INITIAL_STRENGTH,
      };
      const target = result.snapTarget;
      const point = target?.position ?? result.intersection?.point;
      const id = target?.expressId ?? result.intersection?.expressId;
      if (!point || id === undefined) return null;
      const ref = resolveEntityRef(id);
      if (!accepts(ref.modelId)) return null;
      return { modelId: ref.modelId, point: fromRenderTranslation(point),
        kind: target?.type === 'vertex' ? 'vertex' : target?.type === 'edge' ? 'edge'
          : target?.type === 'face' || target?.type === 'face_center' ? 'face' : 'point' };
    };
    let ortho: 'x' | 'y' | 'z' | undefined;
    const updateAnchor = (event: PointerEvent, hit: PlacementAnchor) => {
      const current = useViewerStore.getState();
      current.setMoveAnchor(role, hit);
      const active = useViewerStore.getState().modelPlacement.preview;
      if (role === 'target' && event.shiftKey && active?.source) {
        const direction = subtractTranslation(hit.point, active.source.point);
        ortho = orthogonalAxis(direction, active.constraint, ortho);
        current.previewModelTranslation(constrainTranslation(direction, ortho));
      } else ortho = undefined;
    };
    const move = (event: PointerEvent) => {
      if (event.buttons !== 0) return;
      const hit = pick(event);
      setHover(hit);
      if (hit && role === 'target') {
        try { updateAnchor(event, hit); }
        catch (error) { onError(error instanceof Error ? error.message : String(error)); }
      }
    };
    let nextRole: PickRole | undefined;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopImmediatePropagation(); nextRole = undefined;
      const hit = pick(event);
      if (!hit) { onError('No eligible point found. Zoom closer, choose another point, or enter coordinates.'); return; }
      try {
        updateAnchor(event, hit);
        nextRole = role === 'source' ? 'target' : null;
      } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    };
    // Finish on click, after consuming the whole gesture. Changing the role on
    // pointerdown removed these listeners before release and also selected the
    // IFC entity through the ordinary viewer click handler.
    const release = (event: MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === 'click' && nextRole !== undefined) finish(nextRole);
    };
    canvas.addEventListener('pointerup', release, true);
    canvas.addEventListener('click', release, true);
    canvas.addEventListener('pointermove', move, true);
    canvas.addEventListener('pointerdown', down, true);
    return () => {
      canvas.removeEventListener('pointerup', release, true);
      canvas.removeEventListener('click', release, true);
      canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerdown', down, true);
      canvas.style.cursor = previousCursor;
    };
  }, [role, finish, onError, models, reference]);
  return hover;
}
