/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3359: the annotation overlay channel can carry only grid geometry.
 *
 * `useSymbolicAnnotations` used to lift IfcAnnotation curves AND IfcGridAxis
 * lines into ONE `verts` buffer feeding `renderer.setLineOverlay('annotation',
 * …)`. With "Show IFC Annotations" off and the IfcGrid toggle on, that buffer
 * held only grid lines, but the renderer's `CHANNEL_EXPANDS_MODEL_BOUNDS`
 * table treats EVERYTHING reaching the `annotation` channel as annotation
 * content (`annotation: true`) — the opposite of `grid: false`, which exists
 * because grid axes routinely extend past the model envelope (issue #967).
 * See `packages/renderer/src/renderer-overlays.ts`.
 *
 * `buildSymbolicLineChannels` is the pure merge step behind the hook (no
 * React/store/WASM dependency), so the split is pinned directly against a
 * hand-built `ParseResult` — annotation buckets empty, grid buckets carrying
 * a line that extends far past where any annotation content would be.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolicLineChannels, symbolicLineVertexData, type SymbolicLineChannelsEntry } from './symbolic-line-channels.js';
import { createEmptyParseResult, type AnnotationsForStorey } from '../lib/overlay-parse/symbolic-parse.js';

function gridOnlyEntry(): SymbolicLineChannelsEntry {
  const cached = createEmptyParseResult();
  const farLine: AnnotationsForStorey = {
    storeyId: 1,
    storeyElevation: 0,
    lines: [
      {
        line: { start: { x: -500, y: 0 }, end: { x: 500, y: 0 } },
        category: 'grid',
        ownerId: 42,
      },
    ],
    texts: [],
    fills: [],
  };
  cached.gridByStorey.set(1, farLine);
  return { cached };
}

describe('buildSymbolicLineChannels splits annotation and grid content (issue #3359)', () => {
  it('annotations-off / grid-on: the annotation channel is empty and the grid channel carries the lines', () => {
    const { annotation, grid } = buildSymbolicLineChannels([gridOnlyEntry()], {
      enabled: false,
      effectiveGridEnabled: true,
      clipEnabled: false,
      clipPos: 0,
      clipDepth: 0,
      fallbackY: 0,
    });

    assert.strictEqual(
      symbolicLineVertexData(annotation).length,
      0,
      'a grid-only buffer must not reach the annotation channel — it would ' +
        "carry only grid geometry into `CHANNEL_EXPANDS_MODEL_BOUNDS.annotation` " +
        '(true), which #967/grid:false exists to prevent',
    );
    assert.strictEqual(symbolicLineVertexData(grid).length, 6, 'the grid line (2 verts * 3 floats) must reach the grid channel');
    assert.deepStrictEqual(Array.from(symbolicLineVertexData(grid)), [-500, 0, 0, 500, 0, 0]);
  });

  it('both on: annotation and grid buckets land in their own channel, not merged into one', () => {
    const cached = createEmptyParseResult();
    cached.loose.push({
      line: { start: { x: 1, y: 1 }, end: { x: 2, y: 2 } },
      category: 'annotation',
    });
    cached.gridLoose.push({
      line: { start: { x: -500, y: 0 }, end: { x: 500, y: 0 } },
      category: 'grid',
    });

    const { annotation, grid } = buildSymbolicLineChannels([{ cached }], {
      enabled: true,
      effectiveGridEnabled: true,
      clipEnabled: false,
      clipPos: 0,
      clipDepth: 0,
      fallbackY: 0,
    });

    assert.strictEqual(symbolicLineVertexData(annotation).length, 6, 'annotation channel carries only the annotation line');
    assert.strictEqual(symbolicLineVertexData(grid).length, 6, 'grid channel carries only the grid line');
    assert.notDeepStrictEqual(Array.from(symbolicLineVertexData(annotation)), Array.from(symbolicLineVertexData(grid)));
  });

  it('keeps a 5,000-km placement residual local until the renderer RTE upload (#5049)', () => {
    const cached = createEmptyParseResult();
    cached.loose.push({
      line: {
        start: { x: 5_000_000.015625, y: 0 },
        end: { x: 5_000_000.025625, y: 0 },
      },
      category: 'annotation',
    });
    const { annotation } = buildSymbolicLineChannels([{ cached }], {
      enabled: true,
      effectiveGridEnabled: false,
      clipEnabled: false,
      clipPos: 0,
      clipDepth: 0,
      fallbackY: 0,
    });

    assert.ok(!(annotation instanceof Float32Array), 'national-grid annotation must use the renderer-owned anchor payload');
    if (annotation instanceof Float32Array) return;
    assert.equal(annotation.origin[0], 5_000_000.015625, 'the f64 source anchor retains the centimetre residual');
    assert.ok(
      Math.abs(annotation.localVertices[3] - 0.01) < 1e-8,
      'the second endpoint remains a 1-cm local delta, not f32-rounded world space',
    );
  });
});
