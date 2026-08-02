/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live 3D preview of the Space Sketch draft rooms across EVERY storey.
 *
 * Renders each draft room (on any storey, not just the active one) as a
 * semi-transparent ghost mesh in the 3D scene WITHOUT committing an IfcSpace,
 * so the 2D plan and the model stay coupled while editing. Ghosts reuse the
 * exact same outline + floor elevation + height the eventual create feeds
 * `addSpace`, so a ghost lands pixel-identical to the space it previews —
 * only tinted differently.
 *
 * The building is NEVER hidden: while there is anything to preview, the view
 * X-rays the rest of the model through `ghostExceptEntities` (building fades
 * to the renderer's ghost alpha, rooms stay solid), so the drafts read in the
 * context of the walls they were derived from. The prior view state is
 * captured/restored by `useSpaceSceneFraming` on close.
 *
 * Ghost meshes ride a dedicated scene-overlay channel (`setSpaceOverlayMeshes`
 * → `appendToBatches` direct), bypassing the streaming geometry pipeline so
 * per-edit churn can't reset the camera or break picking.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { buildElementMesh } from '@/store/slices/addElementMeshes';
import type { AddElementSpaceParams } from '@/store/slices/addElementSlice';

/** Draft ghost tint (RGBA 0..1): a cool blue, clearly distinct from the warm
 *  tone of a committed IfcSpace. Alpha sits well above the X-ray ghost alpha
 *  (0.12) so drafts read as "the thing being authored" against the faded
 *  building, while the model still shows through. */
const GHOST_COLOR: [number, number, number, number] = [0.25, 0.62, 0.95, 0.4];

/** Base of the reserved high id band for ghost meshes, far above any real
 *  express/global id in practice. Ghost ids only need to be unique among LIVE
 *  ghosts: every rebuild replaces the whole overlay (the Viewport removes the
 *  previous overlay ids from the scene before appending the new meshes), so
 *  allocation restarts at the band base on each rebuild. A module-level
 *  counter would instead walk upward forever across mounts and long sessions,
 *  creeping toward real federated ids. */
const GHOST_ID_BASE = 0x70000000;

/** First id safely above every real entity: the band base, or one past the
 *  highest federated global id (idOffset + maxExpressId) should offsets ever
 *  reach past the base. Keeps a ghost id from ever colliding with a real
 *  entity in the X-ray filter (`ghostExceptEntities`) or the overlay removal
 *  set (`removeMeshesForEntities`). */
function ghostIdBase(): number {
  let maxReal = 0;
  for (const m of useViewerStore.getState().models.values()) {
    const top = (m.idOffset ?? 0) + (m.maxExpressId ?? 0);
    if (top > maxReal) maxReal = top;
  }
  return Math.max(GHOST_ID_BASE, maxReal + 1);
}

/** One draft room to preview: its boundary outline (plan, metres) + the storey
 *  floor elevation and floor-to-ceiling height for the extrusion. */
export interface GhostSpec {
  corners: [number, number][];
  floorElev: number;
  height: number;
}

interface GhostPreviewArgs {
  /** Tool open AND a model is present — gates all ghost work. */
  enabled: boolean;
  /** Every draft room across every storey (memoised by the overlay). */
  ghosts: GhostSpec[];
  /** Existing IfcSpace ids (federated GLOBAL ids) that should stay solid
   *  alongside the ghosts while the rest of the model is X-rayed. */
  contextIds: number[];
}

export function useSpaceGhostPreview({ enabled, ghosts, contextIds }: GhostPreviewArgs): {
  clearGhosts: () => void;
} {
  const ghostIdsRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextRef = useRef<number[]>(contextIds);
  contextRef.current = contextIds;
  // Whether THIS hook currently owns the X-ray channel — so an empty preview
  // never clears state it didn't set (setGhostExceptEntities(null) also drops
  // isolation as a slice side effect).
  const ghostViewActiveRef = useRef(false);

  // X-ray the model around the rooms: everything except (existing spaces ∪
  // current draft ghosts) fades to the renderer's ghost alpha, so the drafts
  // read against the building instead of replacing it. With nothing to show
  // the X-ray is cleared so the model renders normally.
  const syncGhostView = useCallback(() => {
    const store = useViewerStore.getState();
    // When the tool is off there is nothing to X-ray around, so clear regardless
    // of what the refs still hold. `contextRef` carries the model's EXISTING
    // space ids and is not emptied on disable, so deriving `ids` from the refs
    // unconditionally would re-apply the X-ray on the way out and leave the
    // model ghosted after the tool closed.
    const ids = enabled ? [...contextRef.current, ...ghostIdsRef.current] : [];
    if (ids.length > 0) {
      store.setGhostExceptEntities(new Set(ids));
      ghostViewActiveRef.current = true;
    } else if (ghostViewActiveRef.current) {
      store.setGhostExceptEntities(null);
      ghostViewActiveRef.current = false;
    }
  }, [enabled]);

  // Drop every ghost from the scene's overlay channel. The close path owns the
  // X-ray/view restore afterwards, so this leaves `ghostExceptEntities` alone.
  const clearGhosts = useCallback(() => {
    if (ghostIdsRef.current.length === 0) return;
    useViewerStore.getState().cameraCallbacks.clearSpaceOverlayMeshes?.();
    ghostIdsRef.current = [];
  }, []);

  const rebuild = useCallback(() => {
    const store = useViewerStore.getState();
    if (!enabled) {
      store.cameraCallbacks.clearSpaceOverlayMeshes?.();
      ghostIdsRef.current = [];
      // Re-sync the X-ray view too: the ghost ids it was keyed on are gone, so
      // skipping this leaves the model ghosted against ids that no longer exist.
      syncGhostView();
      return;
    }
    const meshes: ReturnType<typeof buildElementMesh>[] = [];
    const newIds: number[] = [];
    let nextGhostId = ghostIdBase();
    for (const g of ghosts) {
      if (g.corners.length < 3) continue;
      const id = nextGhostId++;
      const params: AddElementSpaceParams = { Width: 0, Depth: 0, Height: g.height };
      const mesh = buildElementMesh({
        type: 'space',
        globalId: id,
        storeyElevation: g.floorElev,
        payload: {
          type: 'space',
          params,
          corners: g.corners.map(([x, y]) => [x, y, 0] as [number, number, number]),
        },
      });
      if (!mesh) continue;
      mesh.color = [...GHOST_COLOR]; // fresh array — never mutate shared COLORS
      meshes.push(mesh);
      newIds.push(id);
    }
    // Replace the overlay in ONE scene operation (no geometryResult churn).
    store.cameraCallbacks.setSpaceOverlayMeshes?.(meshes.filter((m): m is NonNullable<typeof m> => m !== null));
    ghostIdsRef.current = newIds;
    syncGhostView();
  }, [enabled, ghosts, syncGhostView]);

  // Debounced rebuild whenever the draft set changes.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      rebuild();
    }, 80);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [rebuild]);

  // Final cleanup: synchronously drop all ghosts on unmount so none linger.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      clearGhosts();
    };
  }, [clearGhosts]);

  return { clearGhosts };
}
