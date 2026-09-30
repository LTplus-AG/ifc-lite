/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.trimExtend`'s scene layer (charter #6232, C1): the boundary (a
 * solid accent line once picked, dashed while it is only under the cursor),
 * the element a click would take (accent outline, a marker where its axis
 * meets the boundary) and a refused one (dashed red, with the reason beside
 * it). The result itself is the ghost mesh on the `command` overlay channel.
 */

import { useViewerStore } from '@/store';
import type { CommandHudProps, Vec3 } from '@/lib/commands/modeling/types';
import type { TrimExtendGesture } from '@/lib/commands/modeling/commands/trim-extend';
import { boundarySegment } from '@/lib/commands/modeling/commands/trim-extend-model';
import type { Vec2 } from '@/lib/snap/types';
import { WorldLabel, useProjectorTick } from '../../../viewport-ui/scene';

type Screen = { x: number; y: number };
const toWorld = (p: Vec3) => ({ x: p[0], y: p[1], z: p[2] });

export function TrimExtendScene({ gesture, ctx }: CommandHudProps<TrimExtendGesture>) {
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const plane = ctx.workplane;
  void useProjectorTick(plane !== null);
  if (!plane || !projectToScreen) return null;
  const floor = (p: Vec2): Screen | null => projectToScreen(toWorld(plane.localToRender([p[0], p[1], 0])));
  const line = (a: Vec2, b: Vec2) => {
    const [p, q] = [floor(a), floor(b)];
    return p && q ? { p, q } : null;
  };
  const picked = gesture.boundary;
  const shown = picked ?? gesture.hover;
  const segment = shown ? line(...boundarySegment(shown)) : null;
  const { preview } = gesture;
  const outline = preview ? preview.target.outline.map(floor).filter((p): p is Screen => p !== null) : [];
  const crossing = preview?.ok ? floor(preview.point) : null;
  const removed = preview?.ok && preview.removed ? preview.removed.map(floor).filter((p): p is Screen => p !== null) : [];
  const refused = preview && !preview.ok;
  const labelAt = preview && !preview.ok && preview.target.outline.length > 0
    ? plane.localToRender([
      preview.target.outline.reduce((s, p) => s + p[0], 0) / preview.target.outline.length,
      preview.target.outline.reduce((s, p) => s + p[1], 0) / preview.target.outline.length,
      0,
    ])
    : null;
  return (
    <>
      <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }} data-trim-extend-scene>
        {segment && (
          <line
            x1={segment.p.x} y1={segment.p.y} x2={segment.q.x} y2={segment.q.y}
            className="stroke-overlay-accent" strokeWidth={picked ? 3 : 2} strokeDasharray={picked ? undefined : '10 5'} strokeLinecap="round"
            data-trim-mark={picked ? 'boundary' : 'hover'}
          />
        )}
        {outline.length >= 2 && (
          <path
            d={`${outline.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')} Z`}
            fill="currentColor" fillOpacity={0.1}
            className={refused ? 'stroke-status-danger text-status-danger' : 'stroke-overlay-accent text-overlay-accent'}
            strokeWidth={refused ? 2 : 3} strokeDasharray={refused ? '6 4' : undefined} strokeLinejoin="round"
            data-trim-mark={refused ? 'refused' : 'target'}
          />
        )}
        {removed.length >= 3 && (
          <path
            d={`${removed.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')} Z`}
            fill="currentColor" fillOpacity={0.3}
            className="stroke-status-danger text-status-danger" strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round"
            data-trim-mark="removed"
          />
        )}
        {crossing && <circle cx={crossing.x} cy={crossing.y} r={5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2.5} />}
      </svg>
      {labelAt && preview && !preview.ok && (
        <WorldLabel worldPoint={toWorld(labelAt)} offset={{ dx: 8, dy: -14 }} className="border-status-danger">
          {preview.reason}
        </WorldLabel>
      )}
    </>
  );
}
