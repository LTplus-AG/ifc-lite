/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { createEmptyParseResult } from '../overlay-parse/symbolic-shapes';
import { placedSymbols } from './placed-symbols';
import { drawingAnnotationFrame } from './drawing-annotation-frame';

for (const elevation of [100, -100]) it(`keeps loose annotations in the translated section slab at ${elevation} m (#4226)`, () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 10 } };
  const sourceInfo: CoordinateInfo = { originalBounds: bounds, shiftedBounds: bounds,
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false };
  const placedInfo: CoordinateInfo = { ...sourceInfo, shiftedBounds: {
    min: { ...bounds.min, y: bounds.min.y + elevation }, max: { ...bounds.max, y: bounds.max.y + elevation },
  } };
  const frame = drawingAnnotationFrame(placedInfo, sourceInfo, { axis: 'down', position: 50 });
  const parse = createEmptyParseResult();
  parse.loose.push({ category: 'annotation', line: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } });
  const moved = placedSymbols(parse, [0, 0, elevation], frame.fallbackY)!;
  const bucket = [...moved.byStorey.values()][0];
  assert.equal(frame.sectionPosWorld, 10 + elevation);
  assert.equal(bucket.storeyElevation, frame.sectionPosWorld, 'the fallback receives the owning model offset exactly once');
  assert.ok(bucket.storeyElevation! >= frame.sectionPosWorld - frame.viewDepth && bucket.storeyElevation! <= frame.sectionPosWorld,
    'the loose annotation remains inside the section annotation slab');
  assert.equal(bucket.lines.length, 1);
  assert.equal(parse.loose.length, 1, 'the source parse is unchanged');
});
