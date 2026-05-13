/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the symbolic-annotation segment helpers.
 *
 * The full React hook is exercised at integration time (covered by the
 * #653 manual smoke test); here we lock in the geometry conversion that
 * turns WASM-returned polylines/arcs into DrawingLine2D pairs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import { polylineToSegments, circleToSegments } from './useSymbolicAnnotations.js';

describe('polylineToSegments', () => {
  it('emits N-1 segments for an open polyline', () => {
    // 3 points -> 2 segments
    const points = new Float32Array([0, 0, 1, 0, 1, 1]);
    const out: DrawingLine2D[] = [];
    polylineToSegments(points, 3, false, out);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].line.start, { x: 0, y: 0 });
    assert.deepEqual(out[0].line.end, { x: 1, y: 0 });
    assert.deepEqual(out[1].line.start, { x: 1, y: 0 });
    assert.deepEqual(out[1].line.end, { x: 1, y: 1 });
    assert.equal(out[0].category, 'annotation');
  });

  it('adds a closing segment when isClosed is true', () => {
    const points = new Float32Array([0, 0, 2, 0, 2, 2]);
    const out: DrawingLine2D[] = [];
    polylineToSegments(points, 3, true, out);
    // 2 open + 1 closing = 3
    assert.equal(out.length, 3);
    assert.deepEqual(out[2].line.start, { x: 2, y: 2 });
    assert.deepEqual(out[2].line.end, { x: 0, y: 0 });
  });

  it('skips the closing segment for two-point polylines even when isClosed', () => {
    const points = new Float32Array([0, 0, 1, 0]);
    const out: DrawingLine2D[] = [];
    polylineToSegments(points, 2, true, out);
    assert.equal(out.length, 1);
  });

  it('appends to an existing output array without clearing it', () => {
    const points = new Float32Array([0, 0, 1, 0]);
    const out: DrawingLine2D[] = [
      { line: { start: { x: 9, y: 9 }, end: { x: 8, y: 8 } }, category: 'preset' },
    ];
    polylineToSegments(points, 2, false, out);
    assert.equal(out.length, 2);
    assert.equal(out[0].category, 'preset');
    assert.equal(out[1].category, 'annotation');
  });
});

describe('circleToSegments', () => {
  it('tessellates a full circle into 32 segments', () => {
    const out: DrawingLine2D[] = [];
    circleToSegments(0, 0, 1, 0, Math.PI * 2, true, out);
    assert.equal(out.length, 32);
  });

  it('tessellates an arc into 16 segments', () => {
    const out: DrawingLine2D[] = [];
    circleToSegments(0, 0, 1, 0, Math.PI, false, out);
    assert.equal(out.length, 16);
  });

  it('places points on the circle within numerical tolerance', () => {
    const out: DrawingLine2D[] = [];
    circleToSegments(5, 7, 3, 0, Math.PI * 2, true, out);
    for (const seg of out) {
      const dx = seg.line.start.x - 5;
      const dy = seg.line.start.y - 7;
      const r = Math.sqrt(dx * dx + dy * dy);
      assert.ok(Math.abs(r - 3) < 1e-5, `expected radius 3, got ${r}`);
    }
  });

  it('marks output with category "annotation"', () => {
    const out: DrawingLine2D[] = [];
    circleToSegments(0, 0, 1, 0, Math.PI / 2, false, out);
    assert.ok(out.every((seg) => seg.category === 'annotation'));
  });
});
