/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { detectEnclosedAreas, type Segment } from './auto-space-detect.js';

const seg = (a: [number, number], b: [number, number]): Segment => ({ a, b });

describe('detectEnclosedAreas', () => {
  it('finds a single rectangular room', () => {
    const segs: Segment[] = [
      seg([0, 0], [4, 0]),
      seg([4, 0], [4, 3]),
      seg([4, 3], [0, 3]),
      seg([0, 3], [0, 0]),
    ];
    const rooms = detectEnclosedAreas(segs);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].area).toBeCloseTo(12, 5);
  });

  it('splits a T-junction wall into two rooms', () => {
    // Outer 6×3 rectangle plus an internal partition at x=4 dividing
    // the box into a 4×3 room and a 2×3 room.
    const segs: Segment[] = [
      seg([0, 0], [6, 0]),
      seg([6, 0], [6, 3]),
      seg([6, 3], [0, 3]),
      seg([0, 3], [0, 0]),
      seg([4, 0], [4, 3]),
    ];
    const rooms = detectEnclosedAreas(segs);
    expect(rooms).toHaveLength(2);
    const areas = rooms.map((r) => r.area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(6, 5);
    expect(areas[1]).toBeCloseTo(12, 5);
  });

  it('snaps near-coincident endpoints (sloppy wall ends meet at a corner)', () => {
    const segs: Segment[] = [
      seg([0, 0], [4.01, 0]),
      seg([4, 0.01], [4, 3]),
      seg([4.02, 2.99], [0, 3]),
      seg([0.01, 3.01], [0, 0]),
    ];
    const rooms = detectEnclosedAreas(segs, { snapTolerance: 0.05 });
    expect(rooms).toHaveLength(1);
    expect(rooms[0].area).toBeGreaterThan(11.9);
    expect(rooms[0].area).toBeLessThan(12.2);
  });

  it('rejects faces below minArea', () => {
    // Same T-junction split but with minArea cut high enough to drop
    // the smaller 6 m² room.
    const segs: Segment[] = [
      seg([0, 0], [6, 0]),
      seg([6, 0], [6, 3]),
      seg([6, 3], [0, 3]),
      seg([0, 3], [0, 0]),
      seg([4, 0], [4, 3]),
    ];
    const rooms = detectEnclosedAreas(segs, { minArea: 8 });
    expect(rooms).toHaveLength(1);
    expect(rooms[0].area).toBeCloseTo(12, 5);
  });

  it('returns empty for fewer than 3 segments', () => {
    expect(detectEnclosedAreas([])).toEqual([]);
    expect(detectEnclosedAreas([seg([0, 0], [1, 0])])).toEqual([]);
  });

  it('returns empty when segments form an open polyline (no enclosure)', () => {
    const segs: Segment[] = [
      seg([0, 0], [4, 0]),
      seg([4, 0], [4, 3]),
      seg([4, 3], [0, 3]),
      // Missing left wall — no enclosed face.
    ];
    const rooms = detectEnclosedAreas(segs);
    expect(rooms).toHaveLength(0);
  });

  it('handles two non-touching rooms', () => {
    const segs: Segment[] = [
      // Room A
      seg([0, 0], [3, 0]),
      seg([3, 0], [3, 2]),
      seg([3, 2], [0, 2]),
      seg([0, 2], [0, 0]),
      // Room B (offset)
      seg([10, 0], [13, 0]),
      seg([13, 0], [13, 4]),
      seg([13, 4], [10, 4]),
      seg([10, 4], [10, 0]),
    ];
    const rooms = detectEnclosedAreas(segs);
    expect(rooms).toHaveLength(2);
    const areas = rooms.map((r) => r.area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(6, 5);
    expect(areas[1]).toBeCloseTo(12, 5);
  });

  it('T-junction snap: closes a room when wall axes end at perpendicular interiors', () => {
    // Real IFC walls don't share corner vertices — each wall's axis
    // ends at the inside face of the perpendicular wall, so the
    // endpoints land on each other's interior. Without T-junction
    // snap the room never closes.
    const segs: Segment[] = [
      // Outer 4×3 box, but each wall's axis is short by 0.1 m at
      // each end (mimicking 200 mm thick perpendicular walls).
      seg([0.1, 0],   [3.9, 0]),    // bottom
      seg([4,   0.1], [4,   2.9]),  // right
      seg([3.9, 3],   [0.1, 3]),    // top
      seg([0,   2.9], [0,   0.1]),  // left
    ];
    const rooms = detectEnclosedAreas(segs, { snapTolerance: 0.2 });
    expect(rooms).toHaveLength(1);
    expect(rooms[0].area).toBeGreaterThan(11);
  });

  it('produces CCW outlines (positive shoelace area)', () => {
    const segs: Segment[] = [
      seg([0, 0], [4, 0]),
      seg([4, 0], [4, 3]),
      seg([4, 3], [0, 3]),
      seg([0, 3], [0, 0]),
    ];
    const rooms = detectEnclosedAreas(segs);
    const outline = rooms[0].outline;
    let signed = 0;
    for (let i = 0; i < outline.length; i++) {
      const [x1, y1] = outline[i];
      const [x2, y2] = outline[(i + 1) % outline.length];
      signed += x1 * y2 - x2 * y1;
    }
    expect(signed).toBeGreaterThan(0);
  });
});
