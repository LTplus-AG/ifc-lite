/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useProjectorTick`: wakes a React re-render on the shared `SceneProjector`'s
 * dirty tick, replacing a component's own private `requestAnimationFrame`
 * polling loop (the `useCameraTickSubscription` pattern `GizmoOverlay`,
 * `WallEndpointOverlay` and `PlacementGizmo` each ran independently, #5510;
 * `ZoneOverlay`, `SplitOverlay` and `AddElementOverlay` followed, #5512 —
 * `useCameraTickSubscription` itself is deleted once every consumer is off
 * it) with a subscription to the ONE loop the kernel already runs (#5486).
 *
 * A dirty tick fires on real camera motion (the projector's
 * `ProjectorSource.isDirty()`) or any anchor registering/unregistering
 * anywhere in the tree. An occasional extra wake from an unrelated anchor
 * is harmless — the caller re-derives its screen position from
 * `cameraCallbacks.projectToScreen` in its own render body (idempotent,
 * cheap) rather than reading anything off this hook's return value — and far
 * cheaper than a second always-on rAF loop polling the same camera pose.
 *
 * Registers a world-point-less anchor (`getWorldPoint` returns `null`, so
 * `SceneProjector.project()` always yields `HIDDEN_PROJECTION` for it) purely
 * for the wake signal: the projector's tick loop calls every registered
 * anchor's listener once per dirty tick regardless of its own world point
 * (see `projector.ts`'s `tick()`), so a null-returning anchor is a valid,
 * cheap "tell me when something happened" subscription.
 *
 * Returns a `tick` counter to fold into a dependency list — the same shape
 * `useCameraTickSubscription`'s `frameTick` had, so a caller migrating off
 * it is a near drop-in swap. Outside a `SceneProjectorProvider` (e.g. an
 * isolated unit test that doesn't mount `SceneOverlayRoot`) this is a
 * no-op: `useSceneProjector()` returns null, nothing registers, and `tick`
 * never advances — callers that compute their screen position in the
 * render body from store-provided `projectToScreen` (not from this hook's
 * return value) stay correct on the first render regardless.
 */

import { useEffect, useId, useState } from 'react';
import { useSceneProjector } from './SceneProjectorProvider';

export function useProjectorTick(active: boolean): number {
  const projector = useSceneProjector();
  // Each hook instance needs its own anchor id — `GizmoOverlay` and
  // `WallEndpointOverlay` both mount under the same `ToolOverlays`
  // `SceneOverlayRoot` and both call this hook concurrently; a shared
  // fixed id would collide in the projector's anchor map (`Map.set`
  // replacing the earlier registration) and silently drop one of them.
  const id = useId();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active || !projector) return;
    return projector.registerAnchor(
      id,
      () => null,
      () => setTick((n) => (n + 1) % 1_000_000),
    );
  }, [active, projector, id]);

  return tick;
}
