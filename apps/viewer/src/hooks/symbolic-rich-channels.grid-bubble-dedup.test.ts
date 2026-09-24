/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #5583: a structural grid's axis bubble is authored once per axis, but
 * `ensureBucket` (`symbolic-parse.ts`) buckets IfcGridAxis content by
 * elevation the same way it buckets IfcAnnotation content. A bubble that is
 * logically "axis 1" therefore lands in EVERY storey's `gridByStorey` bucket
 * on a multi-storey structural model, so the viewer stacked one
 * circle-and-label per floor down every column — dozens of overlapping
 * bubbles burying `Snowdon_Towers_Sample_Structural` at the opening view.
 *
 * The fix (`pickPrimaryGridBubbleStorey` in symbolic-rich-channels.ts) keeps
 * only the lowest-elevation storey's grid bubbles (text + fill). Grid LINES
 * are untouched — a floor's grid lines are genuine per-floor content, so
 * `buildSymbolicLineChannels` still lifts every storey's grid lines.
 *
 * This runs against the pure #3381 seam (as `symbolic-grid-section-clip.test.ts`
 * does), with a fixture built through the real `buildParseResult` so the
 * storey bucketing is the genuine parse behaviour, not a hand-rolled stand-in
 * for it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolicLineChannels, type SymbolicLineVertices } from './symbolic-line-channels.js';
import { buildSymbolicRichChannels } from './symbolic-rich-channels.js';
import {
  buildParseResult,
  createEmptyFlatSymbolic,
  type FlatSymbolic,
  type ParseResult,
} from '../lib/overlay-parse/symbolic-parse.js';

/** Elevations of three storeys, all carrying "the same" grid axis. */
const ELEVATIONS = [6000, 0, 3000] as const; // deliberately out of order
/** X of the (duplicated) axis, identifiable by coordinate. */
const AXIS_X = 500;

/**
 * One IfcGridAxis line + bubble text + bubble fill per storey in
 * `ELEVATIONS`, all sharing the same X and the same label — the pattern a
 * grid duplicated per floor produces.
 */
function duplicatedGridBubbleFlat(): FlatSymbolic {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcGridAxis'];
  const n = ELEVATIONS.length;

  const polyPoints: number[] = [];
  const polyStart: number[] = [0];
  for (let i = 0; i < n; i++) {
    polyPoints.push(AXIS_X, 0, AXIS_X, 1);
    polyStart.push(polyStart[i]! + 2);
  }
  f.polyPoints = Float32Array.from(polyPoints);
  f.polyStart = Uint32Array.from(polyStart);
  f.polyOwner = Uint32Array.from({ length: n }, (_, i) => 100 + i);
  f.polyWorldY = Float32Array.from(ELEVATIONS);
  f.polyFlags = Uint8Array.from({ length: n }, () => 0);
  f.polyType = Uint16Array.from({ length: n }, () => 0);

  f.textContent = Array.from({ length: n }, () => '1');
  f.textAlignment = Array.from({ length: n }, () => 'center');
  f.textX = Float32Array.from({ length: n }, () => AXIS_X);
  f.textY = Float32Array.from({ length: n }, () => 0);
  f.textDirX = Float32Array.from({ length: n }, () => 1);
  f.textDirY = Float32Array.from({ length: n }, () => 0);
  f.textHeight = Float32Array.from({ length: n }, () => 1);
  f.textTargetPx = Float32Array.from({ length: n }, () => 0);
  f.textColor = new Float32Array(4 * n);
  f.textOwner = Uint32Array.from({ length: n }, (_, i) => 200 + i);
  f.textWorldY = Float32Array.from(ELEVATIONS);
  f.textType = Uint16Array.from({ length: n }, () => 0);

  const fillPoints: number[] = [];
  const fillPointStart: number[] = [0];
  for (let i = 0; i < n; i++) {
    fillPoints.push(AXIS_X, 0, AXIS_X, 1, AXIS_X + 1, 1);
    fillPointStart.push(fillPointStart[i]! + 6);
  }
  f.fillPoints = Float32Array.from(fillPoints);
  f.fillPointStart = Uint32Array.from(fillPointStart);
  f.fillHoles = new Uint32Array(0);
  f.fillHoleStart = Uint32Array.from({ length: n + 1 }, () => 0);
  f.fillColor = new Float32Array(4 * n);
  f.fillHatch = new Float32Array(4 * n);
  f.fillOwner = Uint32Array.from({ length: n }, (_, i) => 300 + i);
  f.fillWorldY = Float32Array.from(ELEVATIONS);
  f.fillFlags = Uint8Array.from({ length: n }, () => 0);
  f.fillType = Uint16Array.from({ length: n }, () => 0);

  return f;
}

function duplicatedGridBubbleParse(): ParseResult {
  return buildParseResult(duplicatedGridBubbleFlat(), {});
}

/** Total vertex-float count in a flat `[x, y, z, …]` line list, across
 *  however many RTE partitions the buffer holds. */
function vertexFloatCount(buffer: SymbolicLineVertices): number {
  const partitions = buffer instanceof Float32Array
    ? [{ localVertices: buffer }]
    : 'localVertices' in buffer ? [buffer] : buffer;
  let total = 0;
  for (const { localVertices } of partitions) total += localVertices.length;
  return total;
}

const GRID_ONLY = {
  enabled: false,
  effectiveGridEnabled: true,
  fallbackY: 0,
  theme: 'light' as const,
  clipEnabled: false,
  clipPos: 0,
  clipDepth: 0,
};

describe('grid bubbles draw once, not once per storey (#5583)', () => {
  it('the fixture really does bucket the axis into three separate storeys', () => {
    const parsed = duplicatedGridBubbleParse();
    assert.equal(parsed.gridByStorey.size, 3, 'one bucket per distinct elevation');
  });

  it('rich channel: only the lowest-elevation storey contributes a bubble text + fill', () => {
    const { texts, fills } = buildSymbolicRichChannels([{ cached: duplicatedGridBubbleParse() }], GRID_ONLY);

    assert.equal(texts.length, 1, `expected exactly one bubble text, got ${texts.length}`);
    assert.equal(texts[0]!.content, '1');
    assert.equal(texts[0]!.origin[1], 0, 'the lowest of the three elevations (0, not 3000 or 6000)');

    assert.equal(fills.length, 1, `expected exactly one bubble fill, got ${fills.length}`);
    assert.equal(fills[0]!.worldY, 0);
  });

  it('line channel: every storey still contributes its grid line (lines are per-floor content)', () => {
    const { grid } = buildSymbolicLineChannels([{ cached: duplicatedGridBubbleParse() }], GRID_ONLY);
    // Each of the 3 storeys' axis line is one 2-point segment == 6 floats
    // (x, y, z per point). Deduping bubbles must not touch this.
    assert.equal(vertexFloatCount(grid), 3 * 2 * 3, 'all three storeys’ grid lines are still present');
  });
});
