/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `wall.place`'s plan layer (charter #6232, M2 §1.5), the 2D twin of
 * `WallPlaceScene`: the placed chain, the rubber band anchor → end and the
 * live length at its middle. The wall body is the ghost footprint the plan
 * draws under it.
 */

import { useViewerStore } from '@/store';
import type { CommandPlanProps } from '@/lib/commands/modeling/types';
import { anchorOf, endPoint, type WallPlaceGesture } from '@/lib/commands/modeling/commands/wall-place-geometry';
import { formatDistance } from '../formatDistance';

export function WallPlacePlan({ gesture, toScreen }: CommandPlanProps<WallPlaceGesture>) {
  const overrides = useViewerStore((s) => s.unitDisplayOverrides);
  const anchor = anchorOf(gesture);
  const end = endPoint(gesture);
  if (!anchor) return null;
  const screen = [...gesture.chain, ...(end ? [end] : [])].map(toScreen);
  const path = screen.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ');
  const length = end ? Math.hypot(end[0] - anchor[0], end[1] - anchor[1]) : 0;
  const mid = end ? toScreen([(anchor[0] + end[0]) / 2, (anchor[1] + end[1]) / 2]) : null;
  return (
    <g data-plan-command="wall.place" pointerEvents="none">
      <path d={path} className="stroke-overlay-accent" fill="none" strokeWidth={2} strokeLinecap="round" />
      {screen.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={3.5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />
      ))}
      {mid && length > 0 && (
        <text x={mid[0] + 8} y={mid[1] - 8} className="fill-overlay-accent text-2xs font-medium tabular-nums">
          {formatDistance(length, overrides)}
        </text>
      )}
    </g>
  );
}
