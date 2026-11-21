/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264: type-hidden meshes are in the scene. Clipping (`full`) must cover
// them whether or not they are shown; framing (`fit`, `robust`) covers what is
// shown at each call, so a class shown mid-stream frames again.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRobustFitBoundsAccumulator, robustFitBoundsFull, type RobustFitMeshInput } from './robustFitBoundsAccumulator.js';

const box = (expressId: number, x0: number, x1: number): RobustFitMeshInput & { expressId: number } =>
  ({ expressId, positions: new Float32Array([x0, 0, 0, x1, 1, 1]) });

it('#10264 full covers excluded meshes; fit follows the exclusions of each call', () => {
  const acc = createRobustFitBoundsAccumulator();
  const stream: (RobustFitMeshInput & { expressId: number })[] = [box(1, 0, 10), box(2, 0, 900)]; // 2: a 900 m opening cutter
  const hidden = new Set([2]);
  const first = acc.update(stream, { excludedIds: hidden, quiet: true })!;
  assert.equal(first.full.max.x, 900, 'clipping covers the hidden cutter');
  assert.equal(first.fit?.max.x, 10, 'framing does not');
  stream.push(box(3, 0, 20));
  const shown = acc.update(stream, { excludedIds: new Set(), quiet: true })!;
  assert.equal(shown.fit?.max.x, 900, 'shown mid-stream, it frames again');
  assert.deepEqual(shown, { ...robustFitBoundsFull(stream, { quiet: true })! }, 'and equals a full rescan without exclusions');
  const again = acc.update(stream, { excludedIds: hidden, quiet: true })!;
  assert.deepEqual(again, robustFitBoundsFull(stream, { excludedIds: hidden, quiet: true }), 'the incremental fold equals a full rescan');
  assert.equal(again.fit?.max.x, 20);
});
