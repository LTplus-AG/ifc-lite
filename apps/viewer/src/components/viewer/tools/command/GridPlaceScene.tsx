/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `grid.place`'s scene layer (charter #6232, D3): the axes' tag bubbles at
 * their ends, so the numbering (and its direction) is readable before the
 * second click. The axes themselves are the ghost mesh on the `command`
 * overlay channel.
 */

import { useViewerStore } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { planGrid, placedAxes, type GridPlaceGesture } from '@/lib/commands/modeling/commands/grid-place-geometry';
import { useProjectorTick } from '../../../viewport-ui/scene';

const BUBBLE_RADIUS = 9;

export function GridPlaceScene({ gesture, ctx }: CommandHudProps<GridPlaceGesture>) {
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const plane = ctx.workplane;
  const plan = plane ? planGrid(gesture, 0) : null;
  void useProjectorTick(plane !== null && plan?.ok === true);
  if (!plane || !plan?.ok || !projectToScreen) return null;
  const project = (p: Vec2) => {
    const r = plane.localToRender([p[0], p[1], 0]);
    return projectToScreen({ x: r[0], y: r[1], z: r[2] });
  };
  // U tags sit at the far end of their axis (the top of a plan), V tags at the near end (the left).
  const bubbles = placedAxes(plan).map((axis) => ({ tag: axis.tag, at: project(axis.family === 'U' ? axis.b : axis.a) }));
  return (
    <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }} data-grid-tags>
      {bubbles.map(({ tag, at }) => at && (
        <g key={tag} transform={`translate(${at.x} ${at.y})`}>
          <circle r={BUBBLE_RADIUS} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={1.5} />
          <text textAnchor="middle" dominantBaseline="central" className="fill-overlay-accent text-2xs font-medium">{tag}</text>
        </g>
      ))}
    </svg>
  );
}
