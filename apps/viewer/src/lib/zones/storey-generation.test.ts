/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  generateStoreyZones,
  DEFAULT_STOREY_ZONE_HEIGHT_M,
  MIN_STOREY_ZONE_HEIGHT_M,
  type StoreyInfo,
} from './storey-generation.js';

function makeIdSequence(): () => string {
  let n = 0;
  return () => `id-${n++}`;
}

const BOUNDS = { minX: -10, maxX: 10, minZ: -5, maxZ: 5 };

describe('zones/storey-generation', () => {
  it('produces one zone per storey', () => {
    const storeys: StoreyInfo[] = [
      { id: 's1', name: 'Ground', elevation: 0 },
      { id: 's2', name: 'Level 1', elevation: 3.5 },
    ];
    const zones = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.strictEqual(zones.length, 2);
  });

  it('spans the given XY bounds exactly, unrotated', () => {
    const storeys: StoreyInfo[] = [{ id: 's1', name: 'Ground', elevation: 0 }];
    const [zone] = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.strictEqual(zone.rotationY, 0);
    assert.strictEqual(zone.size[0], 20); // maxX - minX
    assert.strictEqual(zone.size[2], 10); // maxZ - minZ
    assert.strictEqual(zone.center[0], 0);
    assert.strictEqual(zone.center[2], 0);
  });

  it('sets each zone height to the gap to the next storey up', () => {
    const storeys: StoreyInfo[] = [
      { id: 's1', name: 'Ground', elevation: 0 },
      { id: 's2', name: 'Level 1', elevation: 4 },
    ];
    const [ground] = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.strictEqual(ground.size[1], 4);
    assert.strictEqual(ground.center[1], 2); // 0 + 4/2
  });

  it('falls back to the default height for the topmost storey', () => {
    const storeys: StoreyInfo[] = [{ id: 's1', name: 'Roof', elevation: 20 }];
    const [zone] = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.strictEqual(zone.size[1], DEFAULT_STOREY_ZONE_HEIGHT_M);
  });

  it('sorts storeys by elevation regardless of input order', () => {
    const storeys: StoreyInfo[] = [
      { id: 'top', name: 'Level 2', elevation: 8 },
      { id: 'bottom', name: 'Ground', elevation: 0 },
      { id: 'mid', name: 'Level 1', elevation: 4 },
    ];
    const zones = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.deepStrictEqual(zones.map((z) => z.name), ['Ground', 'Level 1', 'Level 2']);
  });

  it('clamps a degenerate (duplicate or inverted) elevation gap to the minimum height', () => {
    const storeys: StoreyInfo[] = [
      { id: 's1', name: 'A', elevation: 0 },
      { id: 's2', name: 'B', elevation: 0 }, // duplicate elevation
    ];
    const zones = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.strictEqual(zones[0].size[1], MIN_STOREY_ZONE_HEIGHT_M);
  });

  it('names an unnamed storey from its elevation', () => {
    const storeys: StoreyInfo[] = [{ id: 's1', name: '', elevation: 3 }];
    const [zone] = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.ok(zone.name.includes('3.00'));
  });

  it('assigns a fresh id per zone via the injected generator', () => {
    const storeys: StoreyInfo[] = [
      { id: 's1', name: 'A', elevation: 0 },
      { id: 's2', name: 'B', elevation: 3 },
    ];
    const zones = generateStoreyZones(storeys, BOUNDS, makeIdSequence());
    assert.notStrictEqual(zones[0].id, zones[1].id);
  });
});
