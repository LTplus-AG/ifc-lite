/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.align`'s layers (charter #6232, C4), in 3D and in the plan: the
 * reference's box, the picked targets' boxes and the line they line up on.
 * The moved bodies are the command's ghost meshes; these mark what was picked
 * and where the edge is, so the result reads before it is committed.
 */

import { useViewerStore } from '@/store';
import { useProjectorTick } from '@/components/viewport-ui/scene';
import type { Vec2 } from '@/lib/snap/types';
import type { CommandHudProps, CommandPlanProps } from '@/lib/commands/modeling/types';
import { alignsAlongU, edgeOf, type PlanBox } from '@/lib/commands/modeling/align-boxes';
import type { AlignGesture } from '@/lib/commands/modeling/align-gesture';

/** How far the guide runs past the picked boxes (metres). */
const GUIDE_MARGIN = 0.75;

type Map2 = (p: Vec2) => readonly [number, number] | null;

const corners = (box: PlanBox): Vec2[] => [
  [box.min[0], box.min[1]], [box.max[0], box.min[1]], [box.max[0], box.max[1]], [box.min[0], box.max[1]],
];

/** The guide segment for the reference's edge, spanning every picked box. */
function guide(g: AlignGesture): [Vec2, Vec2] | null {
  const reference = g.reference === null ? null : g.boxes.get(g.reference);
  if (!reference) return null;
  const boxes = [reference, ...g.targets.flatMap((id) => g.boxes.get(id) ?? [])];
  const along = alignsAlongU(g.mode) ? 1 : 0;
  const lo = Math.min(...boxes.map((b) => b.min[along])) - GUIDE_MARGIN;
  const hi = Math.max(...boxes.map((b) => b.max[along])) + GUIDE_MARGIN;
  const at = edgeOf(g.mode, reference);
  return along === 1 ? [[at, lo], [at, hi]] : [[lo, at], [hi, at]];
}

function Shapes({ gesture, map }: { gesture: AlignGesture; map: Map2 }) {
  const path = (box: PlanBox) => {
    const points = corners(box).map(map);
    return points.every((p) => p !== null) ? `M${points.map((p) => `${p![0]} ${p![1]}`).join(' L')} Z` : null;
  };
  const reference = gesture.reference === null ? null : gesture.boxes.get(gesture.reference);
  const line = guide(gesture);
  const a = line ? map(line[0]) : null, b = line ? map(line[1]) : null;
  const hover = gesture.hover !== null && gesture.hover !== gesture.reference && !gesture.targets.includes(gesture.hover)
    ? gesture.boxes.get(gesture.hover) : null;
  return (
    <g pointerEvents="none" data-align-layer>
      {hover && path(hover) && <path d={path(hover)!} fill="none" className="stroke-overlay-ink-muted" strokeWidth={1.5} strokeDasharray="2 3" />}
      {gesture.targets.map((id) => {
        const box = gesture.boxes.get(id);
        const d = box ? path(box) : null;
        return d ? <path key={id} d={d} fill="none" className="stroke-overlay-accent" strokeWidth={1.5} strokeDasharray="5 4" /> : null;
      })}
      {reference && path(reference) && <path d={path(reference)!} fill="none" className="stroke-overlay-accent" strokeWidth={2.5} />}
      {a && b && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="stroke-overlay-accent" strokeWidth={1.5} strokeDasharray="8 4" />}
    </g>
  );
}

export function AlignScene({ gesture, ctx }: CommandHudProps<AlignGesture>) {
  const project = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const plane = ctx.workplane;
  void useProjectorTick(plane !== null);
  if (!plane || !project) return null;
  const map: Map2 = (p) => {
    const r = plane.localToRender([p[0], p[1], 0]);
    const screen = project({ x: r[0], y: r[1], z: r[2] });
    return screen ? [screen.x, screen.y] : null;
  };
  return (
    <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
      <Shapes gesture={gesture} map={map} />
    </svg>
  );
}

export function AlignPlan({ gesture, toScreen }: CommandPlanProps<AlignGesture>) {
  return <Shapes gesture={gesture} map={toScreen} />;
}
