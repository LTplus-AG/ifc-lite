/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { assignElementsToZoneSet, assignElementsToZoneSets, STRADDLE_PENETRATION_M } from './assignment.js';
import type { ElementAABB, Zone, ZoneSet } from './types.js';

function makeZone(id: string, centerX: number, overrides: Partial<Zone> = {}): Zone {
  return {
    id,
    name: `Zone ${id}`,
    center: [centerX, 0, 0],
    size: [10, 10, 10],
    rotationY: 0,
    ...overrides,
  };
}

function makeZoneSet(id: string, zones: Zone[]): ZoneSet {
  return { id, name: `Set ${id}`, zones, visible: true, createdAt: 0, updatedAt: 0 };
}

function el(globalId: number, minX: number, maxX: number): ElementAABB {
  return { globalId, min: [minX, -1, -1], max: [maxX, 1, 1] };
}

describe('zones/assignment', () => {
  it('assigns an element fully inside one zone to that zone, not straddling', () => {
    // Zone A at x=[-5,5], Zone B at x=[15,25] (adjacent zones side by side).
    const zoneSet = makeZoneSet('s1', [makeZone('a', 0), makeZone('b', 20)]);
    const elements = [el(1, -2, 2)];
    const result = assignElementsToZoneSet(elements, zoneSet);
    const a = result.get(1)!;
    assert.strictEqual(a.zoneId, 'a');
    assert.strictEqual(a.straddles, false);
    assert.deepStrictEqual(a.touchedZoneIds, ['a']);
  });

  it('flags an element whose AABB crosses two zone boundaries as straddling', () => {
    // Zone A x=[-5,5], Zone B x=[5,15] (share the x=5 boundary exactly).
    const zoneSet = makeZoneSet('s1', [makeZone('a', 0), makeZone('b', 10)]);
    const elements = [el(1, 3, 8)]; // spans across the shared boundary
    const result = assignElementsToZoneSet(elements, zoneSet);
    const a = result.get(1)!;
    assert.strictEqual(a.straddles, true);
    assert.deepStrictEqual(a.touchedZoneIds.sort(), ['a', 'b']);
    // Centroid at x=5.5 falls inside zone b's [5,15] half-open reach (with
    // the shared-boundary eps both zones technically touch x=5, but the
    // centroid itself is unambiguously in b).
    assert.strictEqual(a.zoneId, 'b');
  });

  it('leaves an element outside every zone unassigned, not straddling', () => {
    const zoneSet = makeZoneSet('s1', [makeZone('a', 0)]);
    const elements = [el(1, 100, 101)];
    const result = assignElementsToZoneSet(elements, zoneSet);
    const a = result.get(1)!;
    assert.strictEqual(a.zoneId, null);
    assert.strictEqual(a.straddles, false);
    assert.deepStrictEqual(a.touchedZoneIds, []);
  });

  it('flags straddling when the element overlaps a zone but its centroid sits outside every zone', () => {
    // Element spans from well inside zone A out into empty space beyond it,
    // so its centroid lands outside A but its AABB still overlaps A.
    const zoneSet = makeZoneSet('s1', [makeZone('a', 0)]); // x in [-5, 5]
    const elements = [el(1, 4, 20)]; // centroid at x=12, outside A; overlaps A [4,5]
    const result = assignElementsToZoneSet(elements, zoneSet);
    const a = result.get(1)!;
    assert.strictEqual(a.zoneId, null);
    assert.strictEqual(a.straddles, true);
    assert.deepStrictEqual(a.touchedZoneIds, ['a']);
  });

  it('an empty zone set leaves every element unassigned', () => {
    const zoneSet = makeZoneSet('s1', []);
    const elements = [el(1, 0, 1), el(2, 50, 51)];
    const result = assignElementsToZoneSet(elements, zoneSet);
    assert.strictEqual(result.get(1)!.zoneId, null);
    assert.strictEqual(result.get(2)!.zoneId, null);
  });

  it('assignElementsToZoneSets classifies independently per set', () => {
    const sections = makeZoneSet('sections', [makeZone('sec-a', 0)]);
    const takt = makeZoneSet('takt', [makeZone('takt-a', 0, { size: [4, 10, 10] })]);
    const elements = [el(1, -1, 1)]; // inside both sec-a (wide) and takt-a (narrow)
    const byElement = assignElementsToZoneSets(elements, [sections, takt]);
    const record = byElement.get(1)!;
    assert.strictEqual(record.sections.zoneId, 'sec-a');
    assert.strictEqual(record.takt.zoneId, 'takt-a');
  });

  it('is O(elements x zones): every element gets an entry for every zone set even with no overlap', () => {
    const setA = makeZoneSet('a', [makeZone('z', 1000)]); // far away
    const elements = [el(1, 0, 1), el(2, 2, 3)];
    const byElement = assignElementsToZoneSets(elements, [setA]);
    assert.strictEqual(byElement.size, 2);
    for (const id of [1, 2]) {
      assert.strictEqual(byElement.get(id)!.a.zoneId, null);
    }
  });

  // Zone sets that TILE a building (takt areas / construction sections) are
  // the primary use case, so two zones sharing an exact boundary plane is the
  // common case, not an edge case. An element ENDING exactly at that shared
  // boundary (a wall or slab, very common) must not register as straddling
  // with zero real overlap into the neighbour — that would flood the flag
  // precisely on the models this feature targets. See STRADDLE_PENETRATION_M.
  describe('shared zone-set boundaries (adversarial review follow-up)', () => {
    // Zone A x=[0,10], Zone B x=[10,20] — share the boundary plane at x=10.
    const tiledZoneSet = makeZoneSet('s1', [makeZone('a', 5), makeZone('b', 15)]);

    it('an element ending exactly at the shared boundary touches only its own zone, no straddle', () => {
      const elements = [el(1, 8, 10)]; // ends exactly at x=10, zero penetration into B
      const result = assignElementsToZoneSet(elements, tiledZoneSet);
      const a = result.get(1)!;
      assert.strictEqual(a.zoneId, 'a');
      assert.strictEqual(a.straddles, false);
      assert.deepStrictEqual(a.touchedZoneIds, ['a']);
    });

    it('an element penetrating past the boundary by more than the threshold DOES straddle', () => {
      // 5cm into zone B — comfortably past STRADDLE_PENETRATION_M (1mm).
      assert.ok(0.05 > STRADDLE_PENETRATION_M);
      const elements = [el(1, 8, 10.05)];
      const result = assignElementsToZoneSet(elements, tiledZoneSet);
      const a = result.get(1)!;
      assert.strictEqual(a.straddles, true);
      assert.deepStrictEqual(a.touchedZoneIds.sort(), ['a', 'b']);
      assert.strictEqual(a.zoneId, 'a'); // centroid (x=9.025) is still deep inside A
    });

    it('a degenerate zero-thickness AABB lying exactly ON the boundary picks a deterministic side, not straddling', () => {
      // A collapsed/flattened element sitting exactly at the shared plane:
      // its centroid lies on BOTH zones' inclusive boundary, so the home
      // zone is the first containing zone in set order (a deterministic
      // tie-break by zone order, never float noise). It penetrates neither
      // neighbour past the threshold, so it does not straddle.
      const elements: ElementAABB[] = [{ globalId: 1, min: [10, -1, -1], max: [10, 1, 1] }];
      const result = assignElementsToZoneSet(elements, tiledZoneSet);
      const a = result.get(1)!;
      assert.strictEqual(a.zoneId, 'a');
      assert.strictEqual(a.straddles, false);
      assert.deepStrictEqual(a.touchedZoneIds, ['a']);
    });
  });

  // PR #1869 review: centroid membership must NOT be gated behind the
  // straddle-penetration overlap test. A sliver-thin element hugging a
  // zone's outer face has an in-zone centroid but an overlap depth below
  // STRADDLE_PENETRATION_M on its thin axis; it previously fell through to
  // UNASSIGNED. Home-zone containment is now decided independently.
  describe('thin elements near a zone face (PR #1869 regression)', () => {
    // Zone A spans [-5, 5] on every axis.
    const zoneSet = makeZoneSet('s1', [
      { id: 'a', name: 'Zone a', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 },
    ]);

    it('a 0.5mm-thick element inside the +X face is assigned, not UNASSIGNED', () => {
      const elements: ElementAABB[] = [{ globalId: 1, min: [4.9995, -1, -1], max: [5, 1, 1] }];
      const a = assignElementsToZoneSet(elements, zoneSet).get(1)!;
      assert.strictEqual(a.zoneId, 'a');
      assert.strictEqual(a.straddles, false);
      assert.deepStrictEqual(a.touchedZoneIds, ['a']);
    });

    it('a 0.5mm-thick element inside the +Y face is assigned, not UNASSIGNED', () => {
      const elements: ElementAABB[] = [{ globalId: 1, min: [-1, 4.9995, -1], max: [1, 5, 1] }];
      const a = assignElementsToZoneSet(elements, zoneSet).get(1)!;
      assert.strictEqual(a.zoneId, 'a');
      assert.strictEqual(a.straddles, false);
      assert.deepStrictEqual(a.touchedZoneIds, ['a']);
    });

    it('a 0.5mm-thick element inside the +Z face is assigned, not UNASSIGNED', () => {
      const elements: ElementAABB[] = [{ globalId: 1, min: [-1, -1, 4.9995], max: [1, 1, 5] }];
      const a = assignElementsToZoneSet(elements, zoneSet).get(1)!;
      assert.strictEqual(a.zoneId, 'a');
      assert.strictEqual(a.straddles, false);
      assert.deepStrictEqual(a.touchedZoneIds, ['a']);
    });

    it('centroid in zone A while also genuinely penetrating zone B: home stays A, straddles, touches both', () => {
      // A x=[0,10], B x=[10,20]; element x=[9, 10.05] — centroid at 9.525
      // (inside A), penetrating 5cm into B (past the 1mm threshold).
      const tiled = makeZoneSet('s1', [makeZone('a', 5), makeZone('b', 15)]);
      const a = assignElementsToZoneSet([el(1, 9, 10.05)], tiled).get(1)!;
      assert.strictEqual(a.zoneId, 'a');
      assert.strictEqual(a.straddles, true);
      assert.deepStrictEqual(a.touchedZoneIds.sort(), ['a', 'b']);
    });

    it('a sub-threshold sliver crossing the shared plane resolves by centroid alone, no straddle', () => {
      // A x=[0,10], B x=[10,20]; element x=[9.9993, 10.0005]: centroid at
      // 9.9999 (inside A), overlap depth into A (0.7mm) and into B (0.5mm)
      // both below the 1mm penetration threshold. No zone is "penetrated",
      // so the home zone from the centroid must decide the assignment on
      // its own — previously this fell through to UNASSIGNED.
      const tiled = makeZoneSet('s1', [makeZone('a', 5), makeZone('b', 15)]);
      const a = assignElementsToZoneSet([el(1, 9.9993, 10.0005)], tiled).get(1)!;
      assert.strictEqual(a.zoneId, 'a');
      assert.strictEqual(a.straddles, false);
      assert.deepStrictEqual(a.touchedZoneIds, ['a']);
    });
  });
});
