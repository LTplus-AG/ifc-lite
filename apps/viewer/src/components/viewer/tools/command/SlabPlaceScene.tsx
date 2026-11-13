/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `slab.place`'s scene layer (charter #6232, M2): the outline drawn so far
 * (the rectangle, or the polygon's vertices and the rubber band back to the
 * first one) over the ghost slab, so the vertices stay readable through it
 * and a polygon with fewer than three points still shows.
 */

import { useViewerStore } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { previewOutline, rectangleExtent, type SlabPlaceGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import { useProjectorTick } from '../../../viewport-ui/scene';

export function SlabPlaceScene({ gesture, ctx }: CommandHudProps<SlabPlaceGesture>) {
  const roof = useViewerStore((s) => s.authoringDefaults.slabClass === 'roof');
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const plane = ctx.workplane;
  const placed = gesture.points.length > 0;
  void useProjectorTick(plane !== null && placed);
  if (!plane || !placed || !projectToScreen) return null;
  const outline = previewOutline(gesture) ?? [...gesture.points, ...(gesture.cursor ? [gesture.cursor] : [])];
  const project = (p: Vec2) => {
    const r = plane.localToRender([p[0], p[1], 0]);
    return projectToScreen({ x: r[0], y: r[1], z: r[2] });
  };
  const r = roof && gesture.mode === 'rectangle' ? rectangleExtent(gesture) : null;
  const numbered = r ? [[r.min[0], r.min[1]], [r.min[0] + r.width, r.min[1]], [r.min[0] + r.width, r.min[1] + r.depth], [r.min[0], r.min[1] + r.depth]] as const : outline;
  const screen = numbered.map(project);
  const vertices = gesture.points.map(project);
  if (screen.some((p) => p === null) || vertices.some((p) => p === null)) return null;
  const pts = screen as { x: number; y: number }[];
  const closed = pts.length >= 3;
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ') + (closed ? ' Z' : '');
  return (
    <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
      <path d={path} className="stroke-overlay-accent" fill="none" strokeWidth={2} strokeLinejoin="round" />
      {roof && closed && pts.map((p, i) => {
        const q = pts[(i + 1) % pts.length];
        return <g key={`edge-${i}`}><path d={`M${p.x} ${p.y} L${q.x} ${q.y}`} className="stroke-overlay-accent" strokeWidth={gesture.roof.edge === i ? 4 : 2} /><text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 8}
          className="fill-overlay-accent stroke-overlay-halo text-xs" strokeWidth={3} paintOrder="stroke" fontWeight={gesture.roof.edge === i ? 700 : 400}>{i + 1}</text></g>;
      })}
      {(vertices as { x: number; y: number }[]).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3.5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />
      ))}
    </svg>
  );
}
