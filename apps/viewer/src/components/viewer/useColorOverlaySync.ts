/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The colour-overlay channel's whole path into the renderer: the one-shot
 * flush of `pendingColorUpdates`, split out of `useGeometryStreaming.ts`, plus
 * the catch-up that paints meshes which arrive after that flush (#3890).
 *
 * `pendingColorUpdates` is a SIGNAL, not state — the flush hands it to
 * `scene.setColorOverrides` and then nulls it out. The scene keeps the map
 * (`getColorOverrides()`), and that retained map is the only durable record of
 * what is currently painted. `setColorOverrides` builds overlay batches ONCE,
 * looking each id up in `meshDataMap`, so an id with no mesh at flush time
 * contributes nothing and, without the catch-up below, nothing revisits it.
 *
 * ## Why the catch-up waits for the DRAIN, not for the batch counter
 *
 * `geometryVersion` bumps when a batch is RECEIVED. Received is not painted:
 * `useGeometryStreaming` hands new meshes to `scene.queueMeshes`, and they
 * only enter `meshDataMap` when the animation loop drains that queue under a
 * per-frame time budget. On a large model the last batch is received long
 * before the queue empties, and the counter never bumps again — so a catch-up
 * keyed on the settled counter alone would fire exactly once, mid-drain, find
 * the meshes it is looking for still queued, and never get a second chance.
 * It therefore retries while `scene.hasQueuedMeshes()` is true.
 *
 * That same drain is why the "still waiting for a mesh" set is only narrowed
 * when the queue is EMPTY. `queueMeshes` takes `splitMeshForStreaming`
 * fragments, so one entity can be several `MeshData` sharing an expressId and
 * the drain can stop between them. An id that looks meshed mid-drain may have
 * most of itself still queued; dropping it from the waiting set there would
 * leave a large element painted in part with nothing to repaint the rest.
 *
 * ## The other two decisions
 *
 * The catch-up rebuilds only when an id it was waiting for has since arrived.
 * Without that, an active overlay would pay a full destroy-rebuild-upload
 * cycle after every later streaming burst, forever. Note the test is "did an
 * awaited id ARRIVE", not "is anything still awaited": #3880 puts the
 * geometry-less assembly id itself in the colour map next to its parts, and
 * that id never gains a mesh, so the latter would never short-circuit in
 * exactly the case this module exists for.
 *
 * And it re-hands the scene its OWN retained map, read at the moment it fires,
 * never a remembered one. That is what keeps a targeted `resetColors([part])`
 * from being repainted (the reset flushed a smaller map, so the reset id is
 * not in what the scene hands back) and keeps a correction made in the
 * meantime from being overwritten. Both hazards come from a re-expansion
 * prototype dropped in favour of #3880, both have a test in
 * `useColorOverlaySync.late-mesh.test.tsx`, and both fall out of that one
 * decision rather than needing a branch each.
 *
 * NOT COVERED, deliberately: the other colour sink, `updateMeshColors`, which
 * mutates mesh colours in `meshDataMap` in place and retains no map. There is
 * nothing to re-apply for it; giving it one is a new retained-state decision,
 * not a repaint. Deeper still, the renderer could fold a late mesh into the
 * live overlay batches inside `appendToBatches`, which would be incremental
 * and channel-agnostic instead of a whole-set rebuild. That is a renderer
 * change well outside this fix.
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer, SceneContents } from '@ifc-lite/renderer';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';

/** How long the geometry counter must hold still before the catch-up starts. */
const REPAINT_DEBOUNCE_MS = 250;
/** Re-check interval while the mesh queue is still draining. */
const DRAIN_POLL_MS = 250;

type ColorMap = Map<number, [number, number, number, number]>;

/**
 * Whether the scene can paint this id. Both halves are O(1) map lookups —
 * `getMeshDataPieces` and `getInstancedMeshDataPieces` answer the same
 * question but MATERIALIZE geometry to do it (per-entity extraction out of a
 * colour-merged batch; a fresh transformed Float32Array per occurrence), which
 * a presence probe run over every override id must never pay.
 */
function isMeshed(scene: SceneContents, expressId: number): boolean {
  return scene.hasMeshData(expressId) || scene.isInstancedEntity(expressId);
}

export interface UseColorOverlaySyncParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  pendingColorUpdates: ColorMap | null;
  clearPendingColorUpdates: () => void;
  /**
   * Monotonic per-batch geometry counter (`ViewportContainer.tsx`). Every bump
   * means meshes may have arrived that a live colour overlay has never seen.
   */
  geometryVersion?: number;
}

export function useColorOverlaySync({
  rendererRef,
  isInitialized,
  pendingColorUpdates,
  clearPendingColorUpdates,
  geometryVersion,
}: UseColorOverlaySyncParams): void {
  /** Override ids not yet known to be paintable. See the drain note above. */
  const awaitingMeshRef = useRef<number[]>([]);

  const recordAwaitingMesh = useCallback(
    (scene: SceneContents, overrides: ReadonlyMap<number, unknown>) => {
      const ids = [...overrides.keys()];
      // Mid-drain an id can look meshed while most of it is still queued, so
      // narrow the set only once the queue is empty.
      awaitingMeshRef.current = scene.hasQueuedMeshes()
        ? ids
        : ids.filter((id) => !isMeshed(scene, id));
    },
    [],
  );

  useEffect(() => {
    if (pendingColorUpdates === null || !isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    const scene = renderer.getScene();
    if (device && pipeline) {
      if (pendingColorUpdates.size === 0) {
        scene.clearColorOverrides();
        awaitingMeshRef.current = [];
      } else {
        scene.setColorOverrides(pendingColorUpdates, device, pipeline);
        recordAwaitingMesh(scene, pendingColorUpdates);
      }
      renderer.requestRender();
      clearPendingColorUpdates();
    }
    // rendererRef is a ref; re-running on its identity would be meaningless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingColorUpdates, isInitialized, clearPendingColorUpdates, recordAwaitingMesh]);

  // ─── Catch up meshes that streamed in after the flush ────────────────
  const settledGeometryVersion = useDebouncedValue(geometryVersion, REPAINT_DEBOUNCE_MS);
  useEffect(() => {
    if (!isInitialized) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt = () => {
      // Cheapest guard first: with no overrides installed, or none of them
      // waiting on a mesh, there is nothing to catch up and the scene is not
      // worth asking. This is the common case — most sessions never colour
      // anything — so it must not poll a drain or touch the renderer.
      if (awaitingMeshRef.current.length === 0) return;
      const renderer = rendererRef.current;
      if (!renderer) return;
      const scene = renderer.getScene();
      if (scene.hasQueuedMeshes()) {
        timer = setTimeout(attempt, DRAIN_POLL_MS);
        return;
      }
      if (!awaitingMeshRef.current.some((id) => isMeshed(scene, id))) return;

      const overrides = scene.getColorOverrides();
      if (!overrides || overrides.size === 0) return;
      const device = renderer.getGPUDevice();
      const pipeline = renderer.getPipeline();
      if (!device || !pipeline) return;

      // The scene copies what it is handed, so handing back its own map is
      // safe and the cast only satisfies the mutable-Map parameter type.
      scene.setColorOverrides(overrides as ColorMap, device, pipeline);
      recordAwaitingMesh(scene, overrides);
      renderer.requestRender();
    };

    attempt();
    return () => clearTimeout(timer);
    // rendererRef is a ref; re-running on its identity would be meaningless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledGeometryVersion, isInitialized, recordAwaitingMesh]);
}
