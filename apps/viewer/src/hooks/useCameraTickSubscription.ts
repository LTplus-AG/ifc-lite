/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import type { CameraViewpoint } from '@/store/types';

type GetViewpoint = (() => CameraViewpoint | null) | undefined;

/**
 * Wake a React component on camera moves without subscribing to
 * every camera tick. The three tool overlays (Gizmo, WallEndpoint,
 * Split) all need to re-project anchor points whenever the viewport
 * changes, but the camera tick is intentionally non-React (see
 * `Viewport.tsx` `updateCameraRotationRealtime`) so a manual RAF
 * loop is required.
 *
 * The hook:
 *   - returns a `frameTick` integer that increments only when the
 *     viewpoint signature changes (position, target, fov,
 *     projectionMode, orthoSize). Include this in your dependency
 *     arrays to force re-render on real camera motion.
 *   - bails when `active` is false to keep idle overlays free of
 *     per-frame work.
 *
 * Note: orthoSize + projectionMode are part of the signature so
 * ortho-zoom-only changes (which leave position / target / fov
 * untouched) still wake the subscriber.
 */
export function useCameraTickSubscription(
  getViewpoint: GetViewpoint,
  active: boolean,
): number {
  const [frameTick, setFrameTick] = useState(0);
  const lastViewpointRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const vp = getViewpoint?.();
      if (vp) {
        const sig = `${vp.position.x},${vp.position.y},${vp.position.z},${vp.target.x},${vp.target.y},${vp.target.z},${vp.fov},${vp.projectionMode},${vp.orthoSize ?? ''}`;
        if (sig !== lastViewpointRef.current) {
          lastViewpointRef.current = sig;
          setFrameTick((n) => (n + 1) % 1_000_000);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [active, getViewpoint]);

  return frameTick;
}
