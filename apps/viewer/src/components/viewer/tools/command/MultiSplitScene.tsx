/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `split.multi`'s scene layer (charter #6232, C5): the cut line, the elements
 * it will split (accent, with a marker where it meets each axis) and the ones
 * it crosses but cannot split (danger, dashed, with the reason beside them).
 * The cut plane itself is the ghost mesh on the `command` overlay channel.
 */

import { useViewerStore } from '@/store';
import type { CommandHudProps, Vec3 } from '@/lib/commands/modeling/types';
import { cutExtent, type MultiSplitGesture } from '@/lib/commands/modeling/commands/multi-split';
import { WorldLabel, useProjectorTick } from '../../../viewport-ui/scene';

type Screen = { x: number; y: number };

/** More reasons than this would bury the model; the bar's tooltip lists them all. */
const MAX_REASON_LABELS = 6;
const toWorld = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] });
const midpoint = (points: readonly Vec3[]): Vec3 => {
  const sum = points.reduce<Vec3>((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
};

export function MultiSplitScene({ gesture, ctx }: CommandHudProps<MultiSplitGesture>) {
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const plane = ctx.workplane;
  const extent = cutExtent(gesture, ctx);
  void useProjectorTick(plane !== null && extent !== null);
  if (!plane || !extent || !projectToScreen) return null;
  const project = (p: Vec3): Screen | null => projectToScreen(toWorld(p));
  const floor = (p: readonly [number, number]) => project(plane.localToRender([p[0], p[1], 0]));
  const [from, to] = [floor(extent[0]), floor(extent[1])];
  const anchors = [gesture.a, gesture.b].map((p) => (p ? floor(p) : null));
  const outlines = gesture.plan.marks.map((mark) => {
    const points = mark.outline.map(project).filter((p): p is Screen => p !== null);
    return { mark, points, at: mark.at ? project(mark.at) : null };
  });
  const reasons = gesture.plan.marks.filter((m) => m.status === 'refused' && m.reason && m.outline.length > 0).slice(0, MAX_REASON_LABELS);
  return (
    <>
      <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }} data-multi-split-scene>
        {outlines.map(({ mark, points, at }) => {
          if (points.length < 2) return null;
          const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ') + (mark.closed ? ' Z' : '');
          const refused = mark.status === 'refused';
          return (
            <g key={`${mark.modelId}:${mark.expressId}`} data-cut-mark={mark.status}>
              <path
                d={d}
                fill={mark.closed ? 'currentColor' : 'none'}
                fillOpacity={mark.closed ? 0.1 : 0}
                className={refused ? 'stroke-status-danger text-status-danger' : 'stroke-overlay-accent text-overlay-accent'}
                strokeWidth={refused ? 2 : 3}
                strokeDasharray={refused ? '6 4' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {at && <circle cx={at.x} cy={at.y} r={5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2.5} />}
            </g>
          );
        })}
        {from && to && (
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="stroke-overlay-accent" strokeWidth={2} strokeDasharray="10 5" strokeLinecap="round" />
        )}
        {anchors.map((p, i) => p && (
          <circle key={i} cx={p.x} cy={p.y} r={4.5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2.5} />
        ))}
      </svg>
      {reasons.map((mark) => (
        <WorldLabel key={`${mark.modelId}:${mark.expressId}`} worldPoint={toWorld(midpoint(mark.outline))} offset={{ dx: 8, dy: -14 }} className="border-status-danger">
          {mark.reason}
        </WorldLabel>
      ))}
    </>
  );
}
