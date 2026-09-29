/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `plan.move`'s layer in the plan (charter #6232, B3): the move from the
 * grabbed point to the cursor, and the handle where it will land.
 */

import type { CommandPlanProps } from '@/lib/commands/modeling/types';
import type { PlanMoveGesture } from '@/lib/commands/modeling/commands/plan-move';

/** The landing marker's radius, px: the plan handles' size. */
const MARKER_RADIUS_PX = 6;

export function PlanMoveLayer({ gesture, toScreen }: CommandPlanProps<PlanMoveGesture>) {
  const { base, to } = gesture;
  if (!base || !to) return null;
  const [x0, y0] = toScreen(base);
  const [x1, y1] = toScreen(to);
  return (
    <g data-plan-command="plan.move" pointerEvents="none" className="stroke-overlay-accent">
      <line x1={x0} y1={y0} x2={x1} y2={y1} strokeWidth={1.5} strokeDasharray="5 4" />
      <circle cx={x1} cy={y1} r={MARKER_RADIUS_PX} className="fill-overlay-halo" strokeWidth={2} />
    </g>
  );
}
