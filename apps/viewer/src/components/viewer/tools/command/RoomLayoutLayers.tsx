/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Room tool's layout layers (charter #6232 M4), drawn in the plan and
 * over the 3D view by `RoomPlaceLayers` through the same local → screen map:
 *
 *   - Edit mode: the storey's layout on the wall axes (rooms solid,
 *     candidates dashed), its corners, the corner or edge under the cursor
 *     (red in Merge · Remove), a dragged corner with the outlines following
 *     it, and a cut from its first point to the cursor;
 *   - leak diagnostics (`room-leaks.ts`): the walls that enclose no room and
 *     the wall ends that touch nothing, where a region leaks out.
 */

import type { Vec2 } from '@/lib/snap/types';
import type { Pt } from '@/lib/space-sketch-geometry';
import type { RoomCandidate } from '@/lib/rooms/storey-rooms';
import type { Leaks } from '@/lib/rooms/room-leaks';
import type { RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';

type ToScreen = (p: Vec2) => readonly [number, number] | null;

function pathOf(points: readonly (readonly [number, number])[], closed: boolean): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ') + (closed ? ' Z' : '');
}

const same = (p: Pt, q: Vec2) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;

/** Edit mode: the layout, its corners and the edit in progress. */
export function RoomEditShapes({ gesture, rooms, toScreen }: { gesture: RoomPlaceGesture; rooms: readonly RoomCandidate[]; toScreen: ToScreen }) {
  const { drag, cut, hover, tool } = gesture.edit;
  const moved = (p: Pt): Vec2 => (drag && same(p, drag.from) ? drag.to : p);
  const project = (pts: readonly Vec2[]) => {
    const out = pts.map((p) => toScreen(p));
    return out.some((p) => p === null) ? null : (out as (readonly [number, number])[]);
  };
  const corners = new Map<string, Vec2>();
  for (const room of rooms) for (const p of room.centre) corners.set(`${p[0].toFixed(4)},${p[1].toFixed(4)}`, moved(p));
  const hot = tool === 'remove' ? 'stroke-status-danger' : 'stroke-overlay-accent';
  const hoverScreen = hover ? toScreen(hover.at) : null;
  const edge = hover?.kind === 'edge' ? project([hover.a, hover.b]) : null;
  const cutLine = cut ? project([cut, hover?.at ?? gesture.cursor ?? cut]) : null;
  return (
    <g data-room-edit={tool} data-room-drag={drag ? 'true' : undefined}>
      {rooms.map((room) => {
        const screen = project(room.centre.map(moved));
        if (!screen) return null;
        return (
          <path
            key={room.face}
            data-room-face={room.face}
            data-room-linked={room.room ? room.room.expressId : undefined}
            d={pathOf(screen, true)}
            className={room.room ? 'stroke-overlay-accent' : 'stroke-overlay-ink-muted'}
            fill="none"
            strokeWidth={room.room ? 1.75 : 1.25}
            strokeDasharray={room.room ? undefined : '5 4'}
            strokeLinejoin="round"
          />
        );
      })}
      {[...corners.values()].map((p, i) => {
        const s = toScreen(p);
        return s ? <circle key={i} cx={s[0]} cy={s[1]} r={2.5} className="fill-overlay-halo stroke-overlay-ink-muted" strokeWidth={1} /> : null;
      })}
      {edge && <path data-room-hover="edge" d={pathOf(edge, false)} className={hot} fill="none" strokeWidth={3.5} strokeLinecap="round" />}
      {hover?.kind === 'vertex' && hoverScreen && !drag && (
        <circle data-room-hover="vertex" cx={hoverScreen[0]} cy={hoverScreen[1]} r={6} className={`fill-overlay-halo ${hot}`} strokeWidth={2} />
      )}
      {drag && (() => {
        const s = toScreen(drag.to);
        return s ? <circle cx={s[0]} cy={s[1]} r={6} className="fill-overlay-accent stroke-overlay-halo" strokeWidth={2} /> : null;
      })()}
      {cutLine && <path data-room-cut d={pathOf(cutLine, false)} className="stroke-overlay-accent" fill="none" strokeWidth={2} strokeDasharray="6 4" />}
    </g>
  );
}

/** Leak diagnostics: the walls that close no room, and the open wall ends. */
export function RoomLeakShapes({ leaks, toScreen }: { leaks: Leaks; toScreen: ToScreen }) {
  return (
    <g data-room-leaks={leaks.openEnds.length}>
      {leaks.walls.filter((w) => !w.bounding).map((w, i) => {
        const a = toScreen(w.a), b = toScreen(w.b);
        return a && b
          ? <path key={i} data-room-leak-wall d={pathOf([a, b], false)} className="stroke-status-danger" fill="none" strokeWidth={3} strokeLinecap="round" strokeOpacity={0.8} />
          : null;
      })}
      {leaks.openEnds.map((p, i) => {
        const s = toScreen(p);
        return s ? <circle key={i} data-room-open-end cx={s[0]} cy={s[1]} r={7} className="fill-none stroke-status-danger" strokeWidth={2.5} /> : null;
      })}
    </g>
  );
}
