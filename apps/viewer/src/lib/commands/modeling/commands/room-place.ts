/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place` (charter #6232 M4): the Room tool, which supersedes Space
 * Sketch and the Add Element panel's Auto Spaces.
 *
 * The storey's rooms are the faces of its room layout, the wasm DCEL built
 * from its walls (decision D4, `lib/rooms/storey-rooms.ts`). Pick mode
 * shows the face under the cursor and its area; a click makes it an IfcSpace.
 * Draw mode makes a free room from a clicked outline. Edit mode reshapes the
 * layout — move a corner, cut a room, merge two, remove a corner — and the
 * rooms with it (`room-place-edit.ts`). The bar's Auto makes every face
 * without a room a room (on this storey, or on all of them), Footprint makes
 * one room over the storey's whole outline, Update rooms re-derives the
 * selected rooms' outlines from the current walls (D5: a snapshot at commit,
 * refreshed only on request), and Clean up prunes the layout's orphans. Every
 * action is one transaction, so one undo step, Auto included.
 */

import { RoomPlaceBar } from '@/components/viewer/tools/command/RoomPlaceBar';
import { RoomPlacePlan, RoomPlaceScene } from '@/components/viewer/tools/command/RoomPlaceLayers';
import { resolve as translate } from '@/i18n/registry';
import { ensureSpaceWasm } from '@/lib/space-plate-session';
import { roomAt, roomOutline, sessionRooms, storeyRooms, storeySpaceFootprints, storeyWalls, type RoomCandidate } from '@/lib/rooms/storey-rooms';
import { addRoom, candidateRoom, selectedRooms, updateRoomOutline } from '@/lib/rooms/room-writes';
import { storeyFootprintFace } from '@/lib/rooms/storey-footprint';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { polyArea } from '@/lib/space-sketch-geometry';
import type { ViewerState } from '@/store';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import { notifyCommandRefusal } from '../runtime.js';
import type { AuthoringTransaction, CommandContext, CommandField, CommitResult, ModelingCommand, Workplane } from '../types.js';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import { defaultsField, dimOf, planeZ } from './placement-shared.js';
import { closesPolygon, rectangleCorner, rectangleExtent, type SlabPlaceGesture } from './slab-place-geometry.js';
import { drawnOutline, initRoomGesture, rememberRoomGesture, roomSettings, sessionRoomGesture, spaceParams, type RoomPlaceGesture } from './room-place-gesture.js';
import { afterLayoutCommit, commitLayoutEdit, editOp, editPointerDown, editPointerMove, editPointerUp, weldOf } from './room-place-edit.js';

const drawRect = (g: RoomPlaceGesture) => g.mode !== 'draw' || g.draw.mode !== 'rectangle';
const withDraw = (g: RoomPlaceGesture, draw: Partial<SlabPlaceGesture>): RoomPlaceGesture => ({ ...g, draw: { ...g.draw, ...draw } });
const rectSide = (axis: 0 | 1) => ({ draw }: RoomPlaceGesture): number | null => {
  const first = draw.points[0];
  const corner = rectangleCorner(draw);
  return first && corner ? Math.abs(corner[axis] - first[axis]) : (axis === 0 ? draw.width : draw.depth);
};

const FIELDS: readonly CommandField<RoomPlaceGesture>[] = [
  {
    id: 'width', labelKey: 'modelingCommand.field.width', unit: 'm', group: 'rect',
    hidden: drawRect, read: rectSide(0), write: (g, v) => withDraw(g, { width: Math.abs(v) }),
  },
  {
    id: 'depth', labelKey: 'modelingCommand.field.depth', unit: 'm', group: 'rect',
    hidden: drawRect, read: rectSide(1), write: (g, v) => withDraw(g, { depth: Math.abs(v) }),
  },
  defaultsField('height', 'space', 'Height', 'modelingCommand.field.height'),
];

function readyRooms(s: ViewerState, modelId: string, storeyId: number, plane: Workplane, weld: number): RoomCandidate[] {
  const rooms = storeyRooms(s, modelId, storeyId, plane, weld);
  if (rooms.status === 'loading') throw new Error(translate('roomTool.loading'));
  return rooms.status === 'ready' ? rooms.rooms : [];
}

/** `Room <n>`, numbered on from the rooms the storey already has. */
const roomNamer = (s: ViewerState, modelId: string, storeyId: number) => {
  const existing = storeySpaceFootprints(s, modelId, storeyId).length;
  return (i: number) => `Room ${existing + i + 1}`;
};

const isEdit = (g: RoomPlaceGesture) => g.action === 'edit' || (g.action === 'place' && g.mode === 'edit');

function roomsOf(ctx: CommandContext, g: RoomPlaceGesture): RoomCandidate[] {
  const rooms = sessionRooms(ctx, weldOf(g));
  return rooms?.status === 'ready' ? rooms.rooms : [];
}

/** Auto: every free face of the storey `storeyId` on `plane` becomes a room. */
function autoRooms(tx: AuthoringTransaction, g: RoomPlaceGesture, storeyId: number, plane: Workplane): number[] {
  const get = () => tx.store;
  const height = dimOf({ get }, 'space', 'Height');
  const name = roomNamer(get(), tx.modelId, storeyId);
  return readyRooms(get(), tx.modelId, storeyId, plane, weldOf(g)).filter((r) => !r.taken).map((room, i) => addRoom(get, tx.modelId, storeyId, {
    ...candidateRoom(room, g.boundary), height, z: planeZ(plane), name: name(i), derived: true,
  }));
}

function commitAction(g: RoomPlaceGesture, tx: AuthoringTransaction, storeyId: number, workplane: Workplane): CommitResult | null {
  const { modelId } = tx;
  const get = () => tx.store;
  const made = (ids: number[]): CommitResult => ({ created: ids, authored: ids, deleted: [], remesh: ids, select: ids });
  switch (g.action) {
    case 'update': {
      const roomsOn = (sid: number): RoomCandidate[] => {
        const plane = sid === storeyId ? workplane : buildStoreyWorkplane(get(), modelId, sid, 0);
        return isWorkplane(plane) ? readyRooms(get(), modelId, sid, plane, weldOf(g)) : [];
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
    case 'auto':
      return made(autoRooms(tx, g, storeyId, workplane));
    case 'autoAll': {
      const created: number[] = [];
      for (const storey of modelStoreys(get(), modelId)) {
        const plane = storey.expressId === storeyId ? workplane : buildStoreyWorkplane(get(), modelId, storey.expressId, 0);
        if (isWorkplane(plane)) created.push(...autoRooms(tx, g, storey.expressId, plane));
      }
      if (created.length === 0) throw new Error(translate('roomLayout.autoAll.none'));
      return made(created);
    }
    case 'footprint': {
      if (readyRooms(get(), modelId, storeyId, workplane, weldOf(g)).some((r) => r.taken)) throw new Error(translate('roomLayout.footprint.taken'));
      const face = storeyFootprintFace(storeyWalls(get(), modelId, storeyId, workplane), weldOf(g));
      if (!face) throw new Error(translate('roomTool.noWalls'));
      const id = addRoom(get, modelId, storeyId, {
        outline: roomOutline(face, g.boundary), grossArea: polyArea(face.centre), netArea: polyArea(face.inner),
        height: dimOf({ get }, 'space', 'Height'), z: planeZ(workplane), name: roomNamer(get(), modelId, storeyId)(0), derived: true,
      });
      return made([id]);
    }
    default:
      return null;
  }
}

export const ROOM_PLACE: ModelingCommand<RoomPlaceGesture> = {
  id: 'room.place',
  labelKey: 'roomTool.label',
  hud: {
    Bar: RoomPlaceBar,
    Scene: RoomPlaceScene,
    Plan: RoomPlacePlan,
    hint: (g) => {
      if (g.mode === 'draw' && g.draw.mode === 'rectangle') {
        return g.draw.points.length === 0 ? 'modelingCommand.slab.hintCorner' : 'modelingCommand.slab.hintOpposite';
      }
      if (g.mode === 'draw') return g.draw.points.length < 3 ? 'roomTool.hint.drawCorner' : 'roomTool.hint.drawClose';
      if (g.mode === 'edit') {
        if (g.edit.drag) return 'roomLayout.hint.drop';
        if (g.edit.cut) return 'roomLayout.hint.cutEnd';
        return g.edit.tool === 'remove' ? 'roomLayout.hint.remove' : 'roomLayout.hint.shape';
      }
      if (g.hover?.taken) return 'roomTool.hint.taken';
      if (!g.hover && g.cursor && g.leaks) return 'roomLayout.hint.open';
      return 'roomTool.hint.pick';
    },
  },
  fields: FIELDS,
  snap: 'modeling',
  init: (ctx) => {
    // The DCEL lives in the space wasm; start it now so the first hover finds rooms.
    ensureSpaceWasm().catch((error: unknown) => console.error('[room.place] space wasm failed to load', error));
    return sessionRoomGesture(ctx, { drawMode: ctx.get().authoringDefaults.spaceMode });
  },
  snapQuery: (g) => {
    if (g.mode === 'draw' && g.draw.mode === 'polygon') return { anchor: g.draw.points.at(-1) ?? null, chain: g.draw.points, locks: {} };
    if (g.mode === 'edit') return { anchor: g.edit.drag?.from ?? g.edit.cut ?? null, chain: [], locks: {} };
    return { anchor: null, chain: [], locks: {} };
  },
  pointerMove(g, s, ctx) {
    rememberRoomGesture(ctx, g);
    if (g.mode === 'draw') return { ...withDraw(g, { cursor: s.local, square: s.modifiers?.shift ?? false }), action: 'place' };
    if (g.mode === 'edit') return { ...editPointerMove(g, s, roomsOf(ctx, g)), action: 'place' };
    const rooms = roomsOf(ctx, g);
    return { ...g, cursor: s.local, hover: roomAt(rooms, s.local), action: 'place' };
  },
  pointerDown(g, s) {
    if (g.mode === 'pick') return { commit: true };
    if (g.mode === 'edit') return editPointerDown(g);
    const { draw } = g;
    if (draw.mode === 'rectangle') return draw.points.length === 0 ? withDraw(g, { points: [s.local], cursor: s.local }) : { commit: true };
    if (closesPolygon(draw, s.local)) return { commit: true };
    return withDraw(g, { points: [...draw.points, s.local] });
  },
  pointerUp: (g) => (g.mode === 'edit' ? editPointerUp(g) : g),
  doubleClick: (g) => (g.mode === 'draw' && g.draw.mode === 'polygon' && g.draw.points.length >= 3 ? { commit: true } : g),
  undoPoint: (g) => withDraw(g, { points: g.draw.points.slice(0, -1), ...(g.draw.mode === 'rectangle' ? { width: null, depth: null } : {}) }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    if (g.action === 'update') {
      return selectedRooms(ctx.get(), ctx.modelId).length > 0 ? { ok: true } : { ok: false, reasonKey: 'roomTool.update.noSelection' };
    }
    if (g.action === 'place' && g.mode === 'draw') {
      if (g.draw.mode === 'polygon') return g.draw.points.length >= 3 ? { ok: true } : { ok: false, reasonKey: 'roomTool.draw.needThree' };
      if (g.draw.points.length === 0) return { ok: false, reasonKey: 'modelingCommand.slab.hintCorner' };
      return rectangleExtent(g.draw) ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.slab.noArea' };
    }
    if (g.action === 'autoAll') return { ok: true };
    const rooms = sessionRooms(ctx, weldOf(g));
    if (!rooms || rooms.status === 'loading') return { ok: false, reasonKey: 'roomTool.loading' };
    if (rooms.status === 'noWalls') return { ok: false, reasonKey: 'roomTool.noWalls' };
    if (isEdit(g)) return editOp(g) ? { ok: true } : { ok: false, reasonKey: 'roomLayout.edit.none' };
    if (g.action === 'footprint') return { ok: true };
    if (g.action === 'auto') {
      return rooms.rooms.some((r) => !r.taken) ? { ok: true } : { ok: false, reasonKey: 'roomTool.auto.none' };
    }
    if (!g.hover) return { ok: false, reasonKey: 'roomTool.pick.none' };
    return g.hover.taken ? { ok: false, reasonKey: 'roomTool.pick.taken' } : { ok: true };
  },
  commit(g, tx) {
    const { modelId, storeyId, workplane } = tx;
    if (storeyId === null || !workplane) throw new Error('No storey to draw on');
    if (isEdit(g)) return commitLayoutEdit(g, tx);
    const done = commitAction(g, tx, storeyId, workplane);
    if (done) return done;

    const get = () => tx.store;
    const height = dimOf({ get }, 'space', 'Height');
    const z = planeZ(workplane);
    const name = roomNamer(get(), modelId, storeyId)(0);
    let id: number;
    if (g.mode === 'draw') {
      const made = get().addSpace(modelId, storeyId, { ...spaceParams(g.draw, z, height), Name: name });
      if ('error' in made) throw new Error(`Couldn't add the room: ${made.error}`);
      id = made.expressId;
    } else {
      const room = g.hover;
      if (!room || room.taken) throw new Error(translate(room ? 'roomTool.pick.taken' : 'roomTool.pick.none'));
      id = addRoom(get, modelId, storeyId, { ...candidateRoom(room, g.boundary), height, z, name, derived: true });
    }
    return { created: [id], authored: [id], deleted: [], remesh: [id], select: [id] };
  },
  afterCommit(g, _result, ctx) {
    if (isEdit(g)) afterLayoutCommit(ctx);
    // IfcSpace is class-hidden by default: show the rooms the tool just wrote.
    const s = ctx.get();
    if (!s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
    const next = initRoomGesture(g.mode, roomSettings(g));
    rememberRoomGesture(ctx, next);
    return next;
  },
  ghost(g, ctx) {
    if (!ctx.workplane || g.action !== 'place' || g.mode === 'edit') return [];
    const outline = g.mode === 'draw' ? drawnOutline(g) : g.hover && !g.hover.taken ? roomOutline(g.hover, g.boundary) : null;
    const mesh = prismGhostMesh(ctx.workplane, outline, 0, dimOf(ctx, 'space', 'Height'), commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
