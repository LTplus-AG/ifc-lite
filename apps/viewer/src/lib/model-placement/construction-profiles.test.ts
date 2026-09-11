/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { projectProfiles, type ProfileEntry } from '@ifc-lite/drawing-2d';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState, importPlacements } from './state';
import { placedConstructionProfiles } from './construction-profiles';

it('projects the owning model’s footprint in its placed position and depth band (#4226)', () => {
  const first = fixtureModel('fixed'), second = fixtureModel('moving');
  useViewerStore.setState({ ...fixtureModels(first, second), modelPlacement: importPlacements(emptyPlacementState(),
    new Map([['moving', { translation: [100, 50, 20], locked: false }]])) });
  const profile: ProfileEntry = { expressId: 1, ifcType: 'IfcWall', modelIndex: 0,
    outerPoints: new Float32Array([0, 0, 2, 0, 2, 1, 0, 1]), holeCounts: new Uint32Array(), holePoints: new Float32Array(),
    transform: new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]),
    extrusionDir: new Float32Array([0, 1, 0]), extrusionDepth: 3 };
  const plane = { axis: 'y' as const, position: 24, flipped: false }, bands = { below: 5, above: 5 };
  assert.equal(projectProfiles([profile], plane, bands).length, 0, 'source footprint is outside the moved cut band');
  const placed = placedConstructionProfiles([profile], second.ifcDataStore);
  const lines = projectProfiles(placed, plane, bands);
  assert.equal(lines.length, 4);
  const xs = lines.flatMap((line) => [line.line.start.x, line.line.end.x]);
  assert.equal(Math.min(...xs), 100); assert.equal(Math.max(...xs), 102);
  assert.equal(profile.transform[12], 0); assert.equal(profile.transform[13], 0, 'cached source matrix remains unchanged');
  assert.strictEqual(placedConstructionProfiles([profile], first.ifcDataStore)[0], profile, 'another model does not inherit the move');
});
