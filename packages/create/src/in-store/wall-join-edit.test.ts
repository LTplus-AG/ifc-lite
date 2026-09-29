/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readWallJoinTarget`, `joinWallsInStore` and `reshapeWallsInStore` (#6232 B2):
 * a wall written by the builders reads back as the shape it was given, a pair
 * joined twice keeps one relationship, and moving a shared corner moves both
 * walls and leaves every join current.
 */

import { describe, expect, it } from 'vitest';
import { addWallToStore, type WallInStoreParams } from './wall.js';
import { joinWallsInStore, reshapeWallsInStore } from './wall-join-edit.js';
import { readWallJoinRels, readWallJoinTarget } from './wall-join-read.js';
import { bodyQuad, newStorey } from './wall-join-mesh.oracle.js';
import type { PlanPoint, WallJoinWall } from './wall-join.js';

const HEIGHT = 3;
const wall = (start: PlanPoint, end: PlanPoint, extra: Partial<WallInStoreParams> = {}): WallInStoreParams =>
  ({ Start: [start[0], start[1], 0], End: [end[0], end[1], 0], Thickness: 0.2, Height: HEIGHT, Axis: true, ...extra });

/** A closed 6 x 4 room drawn anticlockwise, one wall per side. */
const ROOM: PlanPoint[] = [[0, 0], [6, 0], [6, 4], [0, 4]];

async function room(scale = 1) {
  const s = await newStorey();
  const ids = ROOM.map((p, i) => addWallToStore(s.editor, s.anchor, wall(p, ROOM[(i + 1) % 4])).wallId);
  return { ...s, ids, scale };
}

function readWall(s: Awaited<ReturnType<typeof newStorey>>, id: number): WallJoinWall {
  const read = readWallJoinTarget(s.store, s.editor.getMutationView(), id, 1);
  if (!read) throw new Error(`wall #${id} unreadable`);
  return read.wall;
}

const near = (a: PlanPoint, b: PlanPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

describe('readWallJoinTarget', () => {
  it('reads what addWallToStore wrote, and tells the plain rectangle from a cut body', async () => {
    const s = await newStorey();
    const built = addWallToStore(s.editor, s.anchor, wall([1, 1], [5, 1], { Offset: 0.05 }));
    const read = readWallJoinTarget(s.store, s.editor.getMutationView(), built.wallId, 1)!;
    expect(read.wall.start).toEqual([1, 1]);
    expect(read.wall.end).toEqual([5, 1]);
    expect(read.wall.thickness).toBeCloseTo(0.2, 9);
    expect(read.wall.offset).toBeCloseTo(0.05, 9);
    expect(read.axisRepId).toBe(built.axisRepId);
    expect(read.plain).toBe(false);
    const flat = addWallToStore(s.editor, s.anchor, wall([1, 2], [5, 2]));
    expect(readWallJoinTarget(s.store, s.editor.getMutationView(), flat.wallId, 1)!.plain).toBe(true);
  });

  it('reads the cuts of a joined body, rectangle and oblique polygon alike', async () => {
    const s = await newStorey();
    const a = addWallToStore(s.editor, s.anchor, wall([0, 0], [4, 0])).wallId;
    const b = addWallToStore(s.editor, s.anchor, wall([4, 0], [4 + 3 * Math.cos(1), 3 * Math.sin(1)])).wallId;
    const joined = joinWallsInStore(s.editor, s.store, s.joinAnchor, a, b);
    expect(joined.join.kind).toBe('L');
    for (const [id, expected] of [[a, joined.join.a.wall], [b, joined.join.b.wall]] as const) {
      const read = readWall(s, id);
      expect(read.start[0]).toBeCloseTo(expected.start[0], 9);
      expect(read.end[1]).toBeCloseTo(expected.end[1], 9);
      const got = bodyQuad(read);
      bodyQuad(expected).forEach((corner, i) => expect(near(got[i], corner)).toBe(true));
    }
  });

  it('refuses what is not a straight wall with a readable body', async () => {
    const s = await newStorey();
    expect(readWallJoinTarget(s.store, s.editor.getMutationView(), s.storeyId, 1)).toBeNull();
    expect(readWallJoinTarget(s.store, s.editor.getMutationView(), 99999, 1)).toBeNull();
  });
});

describe('joinWallsInStore', () => {
  it('a closed room of four walls has four joins', async () => {
    const s = await room();
    for (let i = 0; i < 4; i++) joinWallsInStore(s.editor, s.store, s.joinAnchor, s.ids[i], s.ids[(i + 1) % 4]);
    const rels = readWallJoinRels(s.store, s.editor.getMutationView());
    expect(rels).toHaveLength(4);
    // Each corner is one wall's end and the next wall's start.
  });

  it('a T: the ending wall stops at the through wall face and the through wall keeps its body', async () => {
    const s = await newStorey();
    const through = addWallToStore(s.editor, s.anchor, wall([0, 0], [8, 0])).wallId;
    const ending = addWallToStore(s.editor, s.anchor, wall([4, 5], [4, 0.05])).wallId;
    const result = joinWallsInStore(s.editor, s.store, s.joinAnchor, ending, through);
    expect(result.join.kind).toBe('T');
    expect(readWall(s, through).endCut).toBeUndefined();
    expect(readWall(s, ending).end).toEqual([4, 0]);
    const rel = readWallJoinRels(s.store, s.editor.getMutationView())[0];
    expect(rel.relatingId).toBe(through);
    expect(rel.relatingConnection).toBe('ATPATH');
  });

  it('joining an already joined pair replaces the relationship and keeps its name and priorities', async () => {
    const s = await newStorey();
    const a = addWallToStore(s.editor, s.anchor, wall([0, 0], [4, 0])).wallId;
    const b = addWallToStore(s.editor, s.anchor, wall([4, 0], [4, 3])).wallId;
    const first = joinWallsInStore(s.editor, s.store, s.joinAnchor, a, b, { Name: 'corner', priorities: { a: [10], b: [20] } });
    // The second call comes from the other side and names nothing.
    const second = joinWallsInStore(s.editor, s.store, s.joinAnchor, b, a);
    expect(second.replacedRelIds).toEqual([first.relId]);
    const rels = readWallJoinRels(s.store, s.editor.getMutationView());
    expect(rels).toHaveLength(1);
    expect(rels[0].relId).toBe(second.relId);
    expect(rels[0].name).toBe('corner');
    // `a` ran through before, so it still does, and its priorities stay on it.
    expect(rels[0].relatingId).toBe(a);
    expect(rels[0].relatingPriorities).toEqual([10]);
    expect(rels[0].relatedPriorities).toEqual([20]);
  });

  it('refuses without touching the existing join', async () => {
    const s = await newStorey();
    const a = addWallToStore(s.editor, s.anchor, wall([0, 0], [4, 0])).wallId;
    const b = addWallToStore(s.editor, s.anchor, wall([4, 0], [4, 3])).wallId;
    joinWallsInStore(s.editor, s.store, s.joinAnchor, a, b);
    const far = addWallToStore(s.editor, s.anchor, wall([0, 9], [4, 9])).wallId;
    expect(() => joinWallsInStore(s.editor, s.store, s.joinAnchor, a, far)).toThrow(/do not meet|parallel/);
    expect(readWallJoinRels(s.store, s.editor.getMutationView())).toHaveLength(1);
  });
});

describe('reshapeWallsInStore', () => {
  async function joinedRoom() {
    const s = await room();
    for (let i = 0; i < 4; i++) joinWallsInStore(s.editor, s.store, s.joinAnchor, s.ids[i], s.ids[(i + 1) % 4]);
    return s;
  }

  it('dragging a shared corner moves both walls, and all four joins stay', async () => {
    const s = await joinedRoom();
    const result = reshapeWallsInStore(s.editor, s.store, s.joinAnchor, [{ wallId: s.ids[0], end: [7, 0.5] }], { moveJoinedEnds: true });
    expect(new Set(result.walls)).toEqual(new Set(s.ids));
    expect(result.droppedRelIds).toEqual([]);
    expect(readWall(s, s.ids[0]).end).toEqual([7, 0.5]);
    expect(readWall(s, s.ids[1]).start).toEqual([7, 0.5]);
    // The far ends did not move.
    expect(readWall(s, s.ids[0]).start).toEqual([0, 0]);
    expect(readWall(s, s.ids[1]).end).toEqual([6, 4]);
    const rels = readWallJoinRels(s.store, s.editor.getMutationView());
    expect(rels).toHaveLength(4);
    // The three joins that touch a moved wall are rewritten; the fourth (walls 2 and 3) did not move.
    expect(result.relIds).toHaveLength(3);
    expect(rels.filter((r) => result.relIds.includes(r.relId))).toHaveLength(3);
  });

  it('without moveJoinedEnds the partner holds the corner and the dragged end snaps back to it', async () => {
    const s = await joinedRoom();
    reshapeWallsInStore(s.editor, s.store, s.joinAnchor, [{ wallId: s.ids[0], end: [6.1, 0] }]);
    expect(readWall(s, s.ids[1]).start).toEqual([6, 0]);
    expect(readWall(s, s.ids[0]).end).toEqual([6, 0]);
    expect(readWallJoinRels(s.store, s.editor.getMutationView())).toHaveLength(4);
  });

  it('drops a join whose walls no longer meet and squares the wall that stayed', async () => {
    const s = await newStorey();
    const through = addWallToStore(s.editor, s.anchor, wall([0, 0], [8, 0])).wallId;
    const ending = addWallToStore(s.editor, s.anchor, wall([4, 5], [4, 0])).wallId;
    joinWallsInStore(s.editor, s.store, s.joinAnchor, ending, through);
    expect(readWall(s, ending).endCut).toBeDefined();
    const result = reshapeWallsInStore(s.editor, s.store, s.joinAnchor, [{ wallId: through, start: [0, 20], end: [8, 20] }]);
    expect(result.droppedRelIds).toHaveLength(1);
    expect(readWallJoinRels(s.store, s.editor.getMutationView())).toHaveLength(0);
    expect(readWall(s, ending).endCut).toBeUndefined();
  });

  it('keeps the Axis representation on a wall with no joins', async () => {
    const s = await newStorey();
    const id = addWallToStore(s.editor, s.anchor, wall([0, 0], [4, 0])).wallId;
    reshapeWallsInStore(s.editor, s.store, s.joinAnchor, [{ wallId: id, end: [4, 3] }]);
    const read = readWallJoinTarget(s.store, s.editor.getMutationView(), id, 1)!;
    expect(read.axisRepId).not.toBeNull();
    expect(read.wall.end).toEqual([4, 3]);
    expect(read.plain).toBe(true);
  });

  it('refuses a zero-length wall before writing anything', async () => {
    const s = await joinedRoom();
    const before = s.editor.getNewEntities().length;
    expect(() => reshapeWallsInStore(s.editor, s.store, s.joinAnchor, [{ wallId: s.ids[0], end: [0, 0] }])).toThrow(/no length/);
    expect(s.editor.getNewEntities().length).toBe(before);
  });
});
