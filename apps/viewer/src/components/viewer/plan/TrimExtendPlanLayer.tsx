/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.trimExtend`'s layer in the plan (charter #6232, C1): the boundary,
 * the element a click would take and the refused one with its reason as the
 * outline's tooltip, drawn like the scene layer does (`TrimExtendScene`).
 */

import type { CommandPlanProps } from '@/lib/commands/modeling/types';
import type { TrimExtendGesture } from '@/lib/commands/modeling/commands/trim-extend';
import { boundarySegment } from '@/lib/commands/modeling/commands/trim-extend-model';

const MARKER_RADIUS_PX = 5;

export function TrimExtendPlanLayer({ gesture, toScreen }: CommandPlanProps<TrimExtendGesture>) {
  const picked = gesture.boundary;
  const shown = picked ?? gesture.hover;
  const { preview } = gesture;
  const segment = shown ? boundarySegment(shown).map(toScreen) : null;
  const outline = preview ? preview.target.outline.map(toScreen) : [];
  const refused = preview !== null && !preview.ok;
  const crossing = preview?.ok ? toScreen(preview.point) : null;
  const removed = preview?.ok && preview.removed ? preview.removed.map(toScreen) : [];
  return (
    <g data-plan-command="element.trimExtend" pointerEvents="none">
      {segment && (
        <line
          x1={segment[0][0]} y1={segment[0][1]} x2={segment[1][0]} y2={segment[1][1]}
          className="stroke-overlay-accent" strokeWidth={picked ? 2.5 : 1.5} strokeDasharray={picked ? undefined : '10 5'} strokeLinecap="round"
          data-trim-mark={picked ? 'boundary' : 'hover'}
        />
      )}
      {outline.length >= 2 && (
        <path
          d={`${outline.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ')} Z`}
          fill="currentColor" fillOpacity={0.12}
          className={refused ? 'stroke-status-danger text-status-danger' : 'stroke-overlay-accent text-overlay-accent'}
          strokeWidth={refused ? 2 : 3} strokeDasharray={refused ? '6 4' : undefined} strokeLinejoin="round"
          data-trim-mark={refused ? 'refused' : 'target'}
        >
          {preview && !preview.ok && <title>{preview.reason}</title>}
        </path>
      )}
      {removed.length >= 3 && (
        <path
          d={`${removed.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ')} Z`}
          fill="currentColor" fillOpacity={0.3}
          className="stroke-status-danger text-status-danger" strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round"
          data-trim-mark="removed"
        />
      )}
      {crossing && <circle cx={crossing[0]} cy={crossing[1]} r={MARKER_RADIUS_PX} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />}
    </g>
  );
}
