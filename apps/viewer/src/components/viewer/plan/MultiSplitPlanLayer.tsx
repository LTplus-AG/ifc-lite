/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `split.multi`'s layer in the plan (charter #6232, C5): the cut line, the
 * elements it will split and the ones it crosses but cannot split, drawn like
 * the scene layer does (`MultiSplitScene`), with each refusal's reason as the
 * outline's tooltip.
 */

import type { CommandPlanProps } from '@/lib/commands/modeling/types';
import { cutExtent, type MultiSplitGesture } from '@/lib/commands/modeling/commands/multi-split';

const ANCHOR_RADIUS_PX = 5;

export function MultiSplitPlanLayer({ gesture, ctx, toScreen }: CommandPlanProps<MultiSplitGesture>) {
  const plane = ctx.workplane;
  const extent = cutExtent(gesture, ctx);
  if (!plane || !extent) return null;
  const [x0, y0] = toScreen(extent[0]);
  const [x1, y1] = toScreen(extent[1]);
  return (
    <g data-plan-command="split.multi" pointerEvents="none">
      {gesture.plan.marks.map((mark) => {
        const points = mark.outline.map((p) => {
          const local = plane.renderToLocal(p);
          return toScreen([local[0], local[1]]);
        });
        if (points.length < 2) return null;
        const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ') + (mark.closed ? ' Z' : '');
        const refused = mark.status === 'refused';
        const at = mark.at ? plane.renderToLocal(mark.at) : null;
        const [ax, ay] = at ? toScreen([at[0], at[1]]) : [0, 0];
        return (
          <g key={`${mark.modelId}:${mark.expressId}`} data-cut-mark={mark.status}>
            <path
              d={d}
              fill={mark.closed ? 'currentColor' : 'none'}
              fillOpacity={mark.closed ? 0.12 : 0}
              className={refused ? 'stroke-status-danger text-status-danger' : 'stroke-overlay-accent text-overlay-accent'}
              strokeWidth={refused ? 2 : 3}
              strokeDasharray={refused ? '6 4' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {refused && mark.reason && <title>{mark.reason}</title>}
            </path>
            {at && <circle cx={ax} cy={ay} r={ANCHOR_RADIUS_PX} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />}
          </g>
        );
      })}
      <line x1={x0} y1={y0} x2={x1} y2={y1} className="stroke-overlay-accent" strokeWidth={1.5} strokeDasharray="10 5" strokeLinecap="round" />
    </g>
  );
}
