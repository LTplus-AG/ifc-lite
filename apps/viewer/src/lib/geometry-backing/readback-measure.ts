/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurement/snap readback over released geometry (#10264), loaded only once a
 * scene reports its CPU geometry released (today: the test-only release). One
 * feeder per renderer; the backing is the running debug tap's.
 */

import type { Renderer } from '@ifc-lite/renderer';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { useViewerStore } from '@/store';
import { activeGeometryBackingTap } from './backing-debug-hook';
import { ReadbackRaycastFeeder, type FeedOutcome } from './readback-raycast-feeder';

const feeders = new WeakMap<Renderer, ReadbackRaycastFeeder>();

/** The resident raycast never tests annotation or grid overlays (same rule as `__ifc_lite_pick_parity__`). */
function raycastable(globalId: number): boolean {
  const ref = resolveEntityRef(globalId);
  const type = useViewerStore.getState().models.get(ref.modelId)?.ifcDataStore?.entities.getTypeName(ref.expressId) ?? '';
  return !/^Ifc(Annotation|Grid|GridAxis)$/i.test(type);
}

export function readbackFeeder(renderer: Renderer): ReadbackRaycastFeeder {
  let feeder = feeders.get(renderer);
  if (!feeder) {
    feeder = new ReadbackRaycastFeeder(renderer, () => activeGeometryBackingTap(),
      (globalId) => resolveEntityRef(globalId).modelId, undefined, raycastable);
    feeders.set(renderer, feeder);
    // Pieces stay set on the renderer between hovers; drop them on the same
    // changes that end a backing generation, so a raycast never tests stale geometry.
    const owned = feeder;
    useViewerStore.subscribe((state, previous) => {
      if (state.models !== previous.models || state.geometryContentVersion !== previous.geometryContentVersion) owned.clear();
    });
    // Fed pieces are placed at the scene's placement when they were read. A renderer-side placement change
    // (setModelTranslation/Rotation) moves the GPU geometry with no store change: drop them on its revision too.
    let revision = renderer.getPickGeometryRevision();
    renderer.getScene().onGeometryChange?.(() => {
      const now = renderer.getPickGeometryRevision();
      if (now !== revision) { revision = now; owned.clear(); }
    });
  }
  return feeder;
}

/** Lease and hand the geometry under (x, y) to the renderer's raycast. */
export function feedReadbackAt(renderer: Renderer, x: number, y: number,
  visibility: { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null }): Promise<FeedOutcome> {
  return readbackFeeder(renderer).prepare(x, y, visibility);
}
