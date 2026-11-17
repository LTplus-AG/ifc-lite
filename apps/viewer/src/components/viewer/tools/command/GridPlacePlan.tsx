/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `grid.place`'s plan layer (#9097): the axes the commit will write, as lines
 * with their tag bubbles, in the accent colour and the drawn grid's dash. The
 * ghost mesh merges every axis into one strip mesh, so its plan footprint would
 * be one hull filling the whole grid and hiding the drawing under it.
 */

import type { CommandPlanProps } from '@/lib/commands/modeling/types';
import { planGrid, placedAxes, type GridPlaceGesture } from '@/lib/commands/modeling/commands/grid-place-geometry';
import { gridLabelRadius } from '../../plan/DesignGridLayer';

export function GridPlacePlan({ gesture, toScreen }: CommandPlanProps<GridPlaceGesture>) {
  const plan = planGrid(gesture, 0);
  if (!plan.ok) return null;
  return (
    <g data-plan-layer="grid-ghost" className="stroke-overlay-accent" strokeWidth={1} pointerEvents="none">
      {placedAxes(plan).map((axis) => {
        const a = toScreen(axis.a);
        const b = toScreen(axis.b);
        // The 3D bubbles' ends: U tags at the far end of their axis (the top of a plan), V tags at the near end (the left).
        const [x, y] = axis.family === 'U' ? b : a;
        return (
          <g key={`${axis.family}:${axis.tag}`}>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeDasharray="8 4 2 4" />
            <circle cx={x} cy={y} r={gridLabelRadius(axis.tag)} className="fill-background" />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={11} className="fill-overlay-accent stroke-none">{axis.tag}</text>
          </g>
        );
      })}
    </g>
  );
}
