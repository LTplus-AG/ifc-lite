/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { assignElementsToZoneSet, assignElementsToZoneSets } from './assignment.js';
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
});
