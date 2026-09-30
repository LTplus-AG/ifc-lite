/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place`'s scene and plan layers (charter #6232 M4): the storey's
 * candidate rooms as outlines, each labelled with its area, the one under
 * the cursor emphasised (its volume is the command's ghost); a room that
 * already exists is drawn muted. Draw mode shows the outline so far with its
 * live area; Edit mode, the layout being edited (`RoomLayoutLayers`); Show
 * leaks, why regions aren't closed. The same shapes in 3D (projected off the
 * workplane) and in plan.
 */

import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import type { CommandContext, CommandHudProps, CommandPlanProps } from '@/lib/commands/modeling/types';
import { ensureSpaceWasm, spaceWasmLoaded } from '@/lib/rooms/space-wasm';
import { interiorPoint, roomOutline, sessionRooms, storeyWalls, type RoomCandidate } from '@/lib/rooms/storey-rooms';
import { DEFAULT_WELD } from '@/lib/rooms/room-layout';
import { wallLeaks } from '@/lib/rooms/room-leaks';
import { polyArea, type Pt } from '@/lib/rooms/plate-geometry';
import { drawnOutline, type RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import { useProjectorTick } from '../../../viewport-ui/scene';
import { formatSquareMetres } from '../computePolygonArea';
import { RoomEditShapes, RoomLeakShapes } from './RoomLayoutLayers';

type ToScreen = (p: Vec2) => readonly [number, number] | null;

/** The session storey's candidate rooms at corner weld `weld`, re-read when the walls or the model change. */
export function useSessionRooms(ctx: CommandContext, weld: number | null = null): RoomCandidate[] {
  const [loaded, setLoaded] = useState(spaceWasmLoaded);
  useEffect(() => {
    if (loaded) return;
    let live = true;
    ensureSpaceWasm().then(() => { if (live) setLoaded(true); }, (error: unknown) => console.error('[room.place] space wasm failed to load', error));
    return () => { live = false; };
  }, [loaded]);
  // Subscribed so a new wall mesh or a committed room re-derives the list.
  useViewerStore((s) => s.models.get(ctx.modelId)?.geometryResult?.meshes);
  useViewerStore((s) => s.mutationVersion);
  // And the undo stack: an undo brings back the layout filed under that step.
  useViewerStore((s) => s.undoStacks.get(ctx.modelId)?.length);
  const rooms = loaded ? sessionRooms(ctx, weld ?? DEFAULT_WELD) : null;
  return rooms?.status === 'ready' ? rooms.rooms : [];
}

/** Leaks, when the gesture asks for them. */
function useLeaks(ctx: CommandContext, gesture: RoomPlaceGesture, rooms: readonly RoomCandidate[]) {
  if (!gesture.leaks || !ctx.workplane || ctx.storeyId === null) return null;
  return wallLeaks(storeyWalls(ctx.get(), ctx.modelId, ctx.storeyId, ctx.workplane), rooms, gesture.weld ?? DEFAULT_WELD);
}

function pathOf(points: readonly (readonly [number, number])[], closed: boolean): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ') + (closed ? ' Z' : '');
}

/** What both layers draw, given a local → screen map. */
function RoomShapes({ gesture, rooms, toScreen, ctx }: { gesture: RoomPlaceGesture; rooms: RoomCandidate[]; toScreen: ToScreen; ctx: CommandContext }) {
  const leaks = useLeaks(ctx, gesture, rooms);
  return (
    <>
      {gesture.mode === 'edit' ? <RoomEditShapes gesture={gesture} rooms={rooms} toScreen={toScreen} /> : <RoomModeShapes gesture={gesture} rooms={rooms} toScreen={toScreen} />}
      {leaks && <RoomLeakShapes leaks={leaks} toScreen={toScreen} />}
    </>
  );
}

/** Pick and Draw: the candidates, or the outline being drawn. */
function RoomModeShapes({ gesture, rooms, toScreen }: { gesture: RoomPlaceGesture; rooms: RoomCandidate[]; toScreen: ToScreen }) {
  const project = (pts: readonly Pt[] | readonly Vec2[]) => {
    const out = pts.map((p) => toScreen(p));
    return out.some((p) => p === null) ? null : (out as (readonly [number, number])[]);
  };
  if (gesture.mode === 'draw') {
    const { draw } = gesture;
    const outline = drawnOutline(gesture) ?? [...draw.points, ...(draw.cursor ? [draw.cursor] : [])];
    const screen = project(outline);
    const corners = project(draw.points);
    if (!screen || !corners || screen.length === 0) return null;
    const closed = screen.length >= 3;
    const label = closed ? toScreen(interiorPoint(outline as Pt[])) : null;
    return (
      <g data-room-draw>
        <path d={pathOf(screen, closed)} className="stroke-overlay-accent" fill="none" strokeWidth={2} strokeLinejoin="round" />
        {corners.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3.5} className="fill-overlay-halo stroke-overlay-accent" strokeWidth={2} />)}
        {label && (
          <text x={label[0]} y={label[1]} textAnchor="middle" className="fill-overlay-accent text-2xs font-medium tabular-nums">
            {formatSquareMetres(polyArea(outline as Pt[]))}
          </text>
        )}
      </g>
    );
  }
  const hovered = gesture.hover;
  return (
    <g data-room-candidates={rooms.length}>
      {rooms.map((room) => {
        const outline = roomOutline(room, gesture.boundary);
        const screen = project(outline);
        const label = toScreen(room.interior);
        if (!screen || !label) return null;
        const hot = hovered !== null && hovered.face === room.face;
        const stroke = room.taken ? 'stroke-overlay-ink-muted' : 'stroke-overlay-accent';
        const text = room.taken ? 'fill-overlay-ink-muted' : 'fill-overlay-accent';
        return (
          <g key={room.face} data-room-face={room.face} data-room-taken={room.taken || undefined} data-room-hover={hot || undefined}>
            <path
              d={pathOf(screen, true)}
              className={stroke}
              fill="none"
              strokeWidth={hot ? 2.5 : 1.25}
              strokeDasharray={hot ? undefined : '5 4'}
              strokeLinejoin="round"
            />
            <text x={label[0]} y={label[1]} textAnchor="middle" className={`${text} text-2xs font-medium tabular-nums`}>
              {formatSquareMetres(polyArea(outline))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function RoomPlaceScene({ gesture, ctx }: CommandHudProps<RoomPlaceGesture>) {
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const rooms = useSessionRooms(ctx, gesture.weld);
  const plane = ctx.workplane;
  void useProjectorTick(plane !== null);
  if (!plane || !projectToScreen) return null;
  const toScreen: ToScreen = (p) => {
    const r = plane.localToRender([p[0], p[1], 0]);
    const s = projectToScreen({ x: r[0], y: r[1], z: r[2] });
    return s ? [s.x, s.y] : null;
  };
  return (
    <svg className="absolute inset-0 pointer-events-none z-(--z-scene)" style={{ overflow: 'visible' }}>
      <RoomShapes gesture={gesture} rooms={rooms} toScreen={toScreen} ctx={ctx} />
    </svg>
  );
}

export function RoomPlacePlan({ gesture, ctx, toScreen }: CommandPlanProps<RoomPlaceGesture>) {
  const rooms = useSessionRooms(ctx, gesture.weld);
  return (
    <g data-plan-command="room.place" pointerEvents="none">
      <RoomShapes gesture={gesture} rooms={rooms} toScreen={toScreen} ctx={ctx} />
    </g>
  );
}
