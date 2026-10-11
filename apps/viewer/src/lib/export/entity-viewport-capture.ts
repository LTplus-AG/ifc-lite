/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Renderer } from '@ifc-lite/renderer';
import type { ViewerBounds } from '@ifc-lite/bcf';
import { captureViewportFrame } from '@/lib/viewport-capture';

/** Report, IDS and clash captures share preparation and ownership, never store preferences. */
export function captureEntityViewportFrame(renderer: Renderer, request: {
  ids: Set<number>; mode: 'isolate' | 'ghost'; bounds?: ViewerBounds;
  clearColor: [number, number, number, number];
}): Promise<string | null> {
  const camera = renderer.getCamera();
  const pose = () => ({ position: { ...camera.getPosition() }, target: { ...camera.getTarget() },
    up: { ...camera.getUp() }, orthoSize: camera.getOrthoSize(), mode: camera.getProjectionMode() });
  return captureViewportFrame(renderer, {
    options: {
      hiddenIds: undefined,
      isolatedIds: request.mode === 'isolate' ? request.ids : null,
      ghostExceptIds: request.mode === 'ghost' ? request.ids : null,
      selectedId: null, selectedIds: undefined, selectedModelIndex: undefined,
      hoverOutline: null, emphasizeOverrides: false, clearColor: request.clearColor,
    },
    prepare: () => {
      if (!request.bounds) return;
      const before = pose();
      // The canonical animator applies duration 0 immediately, cancelling its
      // prior tween. Awaiting a positive-duration tween here would deadlock the parked loop.
      void camera.frameBounds(request.bounds.min, request.bounds.max, 0);
      const framed = pose();
      return () => {
        // Preserve a newer direct user camera action while GPU work yielded.
        if (JSON.stringify(pose()) !== JSON.stringify(framed)) return;
        void camera.animateToWithUp(before.position, before.target, before.up, 0);
        camera.setOrthoSize(before.orthoSize);
      };
    },
    read: canvas => canvas.toDataURL('image/png'),
  });
}
