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
import {
  buildSymbolicLineChannels,
  type SymbolicLineChannelsEntry,
} from './useSymbolicAnnotations.js';
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
      annotation.length,
      0,
      'a grid-only buffer must not reach the annotation channel — it would ' +
        "carry only grid geometry into `CHANNEL_EXPANDS_MODEL_BOUNDS.annotation` " +
        '(true), which #967/grid:false exists to prevent',
    );
    assert.strictEqual(grid.length, 6, 'the grid line (2 verts * 3 floats) must reach the grid channel');
    assert.deepStrictEqual(Array.from(grid), [-500, 0, 0, 500, 0, 0]);
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

    assert.strictEqual(annotation.length, 6, 'annotation channel carries only the annotation line');
    assert.strictEqual(grid.length, 6, 'grid channel carries only the grid line');
    assert.notDeepStrictEqual(Array.from(annotation), Array.from(grid));
  });
});
