/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `curtainwall.place`'s scene layer (charter #6232, D3): the base line from
 * the start to the end and its live length. The frame and panels are the
 * ghost meshes on the `command` overlay channel; this keeps the path readable
 * through them.
 */

import { useViewerStore } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { anchorOf, endPoint } from '@/lib/commands/modeling/commands/wall-place-geometry';
import type { CurtainWallGesture } from '@/lib/commands/modeling/commands/curtainwall-place-geometry';
import { formatDistance } from '../formatDistance';
import { WorldLabel, useProjectorTick } from '../../../viewport-ui/scene';

export function CurtainWallPlaceScene({ gesture, ctx }: CommandHudProps<CurtainWallGesture>) {
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const overrides = useViewerStore((s) => s.unitDisplayOverrides);
  const plane = ctx.workplane;
  const anchor = anchorOf(gesture);
  const end = endPoint(gesture);
  void useProjectorTick(plane !== null && anchor !== null);
  if (!plane || !anchor || !projectToScreen) return null;
  const world = (p: Vec2) => {
    const r = plane.localToRender([p[0], p[1], gesture.baseOffset]);
    return { x: r[0], y: r[1], z: r[2] };
  };
  const points = [anchor, ...(end ? [end] : [])].map((p) => projectToScreen(world(p)));
  if (points.some((p) => p === null)) return null;
  const screen = points as { x: number; y: number }[];
  const path = screen.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const length = end ? Math.hypot(end[0] - anchor[0], end[1] - anchor[1]) : 0;
  return (
    <>
      <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
        <path d={path} className="stroke-overlay-accent" fill="none" strokeWidth={2} strokeLinecap="round" />
        {screen.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3.5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />
        ))}
      </svg>
      {end && length > 0 && (
        <WorldLabel worldPoint={world([(anchor[0] + end[0]) / 2, (anchor[1] + end[1]) / 2])} active offset={{ dx: 10, dy: -24 }}>
          {formatDistance(length, overrides)}
        </WorldLabel>
      )}
    </>
  );
}
