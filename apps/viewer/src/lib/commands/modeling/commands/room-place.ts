/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place` (charter #6232 M4): the Room tool, which supersedes Space
 * Sketch and the Add Element panel's Auto Spaces.
 *
 * The storey's rooms are the faces of the wasm DCEL built from its walls,
 * derived on demand (decision D4, `lib/rooms/storey-rooms.ts`). Pick mode
 * shows the face under the cursor and its area; a click makes it an IfcSpace.
 * Draw mode makes a free room from a clicked outline. The bar's Auto makes
 * every face of the storey that has no room yet a room, and Update rooms
 * re-derives the selected rooms' outlines from the current walls (D5: a
 * snapshot at commit, refreshed only on request). Every action is one
 * transaction, so one undo step, Auto included.
 */

import { RoomPlaceBar } from '@/components/viewer/tools/command/RoomPlaceBar';
import { RoomPlacePlan, RoomPlaceScene } from '@/components/viewer/tools/command/RoomPlaceLayers';
import { resolve as translate } from '@/i18n/registry';
import { ensureSpaceWasm } from '@/lib/space-plate-session';
import { polyArea, type Pt } from '@/lib/space-sketch-geometry';
import { roomAt, roomOutline, sessionRooms, storeyRooms, storeySpaceFootprints, type RoomCandidate } from '@/lib/rooms/storey-rooms';
import { addRoom, candidateRoom, selectedRooms, updateRoomOutline } from '@/lib/rooms/room-writes';
import type { ViewerState } from '@/store';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import { notifyCommandRefusal } from '../runtime.js';
import type { CommandContext, CommandField, ModelingCommand, Workplane } from '../types.js';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import { defaultsField, dimOf, planeZ } from './placement-shared.js';
import { closesRoom, drawnOutline, initRoomGesture, type RoomPlaceGesture } from './room-place-gesture.js';

const FIELDS: readonly CommandField<RoomPlaceGesture>[] = [
  defaultsField('height', 'space', 'Height', 'modelingCommand.field.height'),
];

function readyRooms(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): RoomCandidate[] {
  const rooms = storeyRooms(s, modelId, storeyId, plane);
  if (rooms.status === 'loading') throw new Error(translate('roomTool.loading'));
  return rooms.status === 'ready' ? rooms.rooms : [];
}

/** `Room <n>`, numbered on from the rooms the storey already has. */
const roomNamer = (s: ViewerState, modelId: string, storeyId: number) => {
  const existing = storeySpaceFootprints(s, modelId, storeyId).length;
  return (i: number) => `Room ${existing + i + 1}`;
};

function hoverAt(ctx: CommandContext, p: readonly [number, number]): RoomCandidate | null {
  const rooms = sessionRooms(ctx);
  return rooms?.status === 'ready' ? roomAt(rooms.rooms, p) : null;
}

export const ROOM_PLACE: ModelingCommand<RoomPlaceGesture> = {
  id: 'room.place',
  labelKey: 'roomTool.label',
  hud: {
    Bar: RoomPlaceBar,
    Scene: RoomPlaceScene,
    Plan: RoomPlacePlan,
    hint: (g) => {
      if (g.mode === 'draw') return g.points.length < 3 ? 'roomTool.hint.drawCorner' : 'roomTool.hint.drawClose';
      if (g.hover?.taken) return 'roomTool.hint.taken';
      return 'roomTool.hint.pick';
    },
  },
  fields: FIELDS,
  snap: 'modeling',
  init: () => {
    // The DCEL lives in the space wasm; start it now so the first hover finds rooms.
    ensureSpaceWasm().catch((error: unknown) => console.error('[room.place] space wasm failed to load', error));
    return initRoomGesture('pick', 'inner');
  },
  snapQuery: (g) => (g.mode === 'draw'
    ? { anchor: g.points.at(-1) ?? null, chain: g.points, locks: {} }
    : { anchor: null, chain: [], locks: {} }),
  pointerMove: (g, s, ctx) => ({
    ...g,
    cursor: s.local,
    hover: g.mode === 'pick' ? hoverAt(ctx, s.local) : null,
    action: 'place',
  }),
  pointerDown(g, s) {
    if (g.mode === 'pick') return { commit: true };
    if (closesRoom(g, s.local)) return { commit: true };
    return { ...g, points: [...g.points, s.local] };
  },
  doubleClick: (g) => (g.mode === 'draw' && g.points.length >= 3 ? { commit: true } : g),
  undoPoint: (g) => ({ ...g, points: g.points.slice(0, -1) }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    if (g.action === 'update') {
      return selectedRooms(ctx.get(), ctx.modelId).length > 0 ? { ok: true } : { ok: false, reasonKey: 'roomTool.update.noSelection' };
    }
    if (g.action === 'place' && g.mode === 'draw') {
      return g.points.length >= 3 ? { ok: true } : { ok: false, reasonKey: 'roomTool.draw.needThree' };
    }
    const rooms = sessionRooms(ctx);
    if (!rooms || rooms.status === 'loading') return { ok: false, reasonKey: 'roomTool.loading' };
    if (rooms.status === 'noWalls') return { ok: false, reasonKey: 'roomTool.noWalls' };
    if (g.action === 'auto') {
      return rooms.rooms.some((r) => !r.taken) ? { ok: true } : { ok: false, reasonKey: 'roomTool.auto.none' };
    }
    if (!g.hover) return { ok: false, reasonKey: 'roomTool.pick.none' };
    return g.hover.taken ? { ok: false, reasonKey: 'roomTool.pick.taken' } : { ok: true };
  },
  commit(g, tx) {
    const { modelId, storeyId, workplane } = tx;
    if (storeyId === null || !workplane) throw new Error('No storey to draw on');
    const get = () => tx.store;
    const height = dimOf({ get }, 'space', 'Height');
    const z = planeZ(workplane);

    if (g.action === 'update') {
      const roomsOn = (sid: number): RoomCandidate[] => {
        const plane = sid === storeyId ? workplane : buildStoreyWorkplane(get(), modelId, sid, 0);
        return isWorkplane(plane) ? readyRooms(get(), modelId, sid, plane) : [];
      };
      const updated: number[] = [];
      let skipped = 0;
      for (const id of selectedRooms(get(), modelId)) {
        const res = updateRoomOutline(get, modelId, id, g.boundary, roomsOn);
        if (res.ok) updated.push(id);
        else skipped++;
      }
      if (updated.length === 0) throw new Error(translate('roomTool.update.none'));
      if (skipped > 0) notifyCommandRefusal(translate('roomTool.update.skipped', { count: skipped, countDisplay: String(skipped) }));
      return { created: [], deleted: [], remesh: updated, select: updated };
    }

    if (g.action === 'auto') {
      const rooms = readyRooms(get(), modelId, storeyId, workplane);
      const name = roomNamer(get(), modelId, storeyId);
      const created = rooms.filter((r) => !r.taken).map((room, i) => addRoom(get, modelId, storeyId, {
        ...candidateRoom(room, g.boundary), height, z, name: name(i), derived: true,
      }));
      return { created, authored: created, deleted: [], remesh: created, select: created };
    }

    const name = roomNamer(get(), modelId, storeyId)(0);
    let id: number;
    if (g.mode === 'draw') {
      const outline = g.points.map((p): Pt => [p[0], p[1]]);
      const area = polyArea(outline);
      id = addRoom(get, modelId, storeyId, { outline, height, z, name, grossArea: area, netArea: area, derived: false });
    } else {
      const room = g.hover;
      if (!room || room.taken) throw new Error(translate(room ? 'roomTool.pick.taken' : 'roomTool.pick.none'));
      id = addRoom(get, modelId, storeyId, { ...candidateRoom(room, g.boundary), height, z, name, derived: true });
    }
    return { created: [id], authored: [id], deleted: [], remesh: [id], select: [id] };
  },
  afterCommit(g, _result, ctx) {
    // IfcSpace is class-hidden by default: show the rooms the tool just wrote.
    const s = ctx.get();
    if (!s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
    return initRoomGesture(g.mode, g.boundary);
  },
  ghost(g, ctx) {
    if (!ctx.workplane || g.action !== 'place') return [];
    const outline = g.mode === 'draw' ? drawnOutline(g) : g.hover && !g.hover.taken ? roomOutline(g.hover, g.boundary) : null;
    const mesh = prismGhostMesh(ctx.workplane, outline, 0, dimOf(ctx, 'space', 'Height'), commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
