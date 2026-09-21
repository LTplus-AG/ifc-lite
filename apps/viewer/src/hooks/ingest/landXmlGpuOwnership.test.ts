/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import {
  invalidateLandXmlGpuOwnershipAfterSceneClear,
  markLandXmlGpuUploaded,
  takeLandXmlGpuUploaded,
} from './landXmlGpuOwnership.js';

it('consumes a provisional LandXML upload marker exactly once (#5050)', () => {
  const mesh = { expressId: 1 } as MeshData;
  markLandXmlGpuUploaded(mesh);
  assert.equal(takeLandXmlGpuUploaded(mesh), true, 'scene sync must skip the already-uploaded transaction batch');
  assert.equal(takeLandXmlGpuUploaded(mesh), false, 'later scene rebuilds must regain normal ownership');
});

it('does not suppress a re-upload after scene reconciliation clears provisional GPU allocations (#5050)', () => {
  const mesh = { expressId: 2 } as MeshData;
  markLandXmlGpuUploaded(mesh);
  invalidateLandXmlGpuOwnershipAfterSceneClear();
  assert.equal(takeLandXmlGpuUploaded(mesh), false);
});
