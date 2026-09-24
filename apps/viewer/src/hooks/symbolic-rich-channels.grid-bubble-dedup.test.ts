/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #5656: a structural grid's axis bubble is authored once per axis, but
 * `ensureBucket` (`symbolic-parse.ts`) buckets IfcGridAxis content by
 * elevation the same way it buckets IfcAnnotation content. A bubble that is
 * logically "axis 1" therefore lands in EVERY storey's `gridByStorey` bucket
 * on a multi-storey structural model, so the viewer stacked one
 * circle-and-label per floor down every column — dozens of overlapping
 * bubbles burying `Snowdon_Towers_Sample_Structural` at the opening view.
 *
 * The fix lifts the grid buckets lowest-first and skips any bubble (text +
 * fill) already lifted at the same plan position, so each duplicate draws
 * once from the lowest storey in view, while a label that only an upper
 * storey carries still draws. Grid LINES are untouched — a floor's grid
 * lines are genuine per-floor content, so `buildSymbolicLineChannels` still
 * lifts every storey's grid lines.
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

/** One grid axis on one storey: its elevation, bubble label and X. */
interface AxisOnStorey { elevation: number; label: string; x: number }

/** The same axis "1" at `AXIS_X` on every storey in `ELEVATIONS`. */
const DUPLICATED: readonly AxisOnStorey[] = ELEVATIONS.map((elevation) => ({ elevation, label: '1', x: AXIS_X }));

/**
 * One IfcGridAxis line + bubble text + bubble fill per `axes` entry. With
 * the default `DUPLICATED` every storey shares the same X and label — the
 * pattern a grid duplicated per floor produces.
 */
function gridBubbleFlat(axes: readonly AxisOnStorey[] = DUPLICATED): FlatSymbolic {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcGridAxis'];
  const n = axes.length;
  const xs = axes.map((a) => a.x);
  const elevations = axes.map((a) => a.elevation);

  const polyPoints: number[] = [];
  const polyStart: number[] = [0];
  for (let i = 0; i < n; i++) {
    polyPoints.push(xs[i]!, 0, xs[i]!, 1);
    polyStart.push(polyStart[i]! + 2);
  }
  f.polyPoints = Float32Array.from(polyPoints);
  f.polyStart = Uint32Array.from(polyStart);
  f.polyOwner = Uint32Array.from({ length: n }, (_, i) => 100 + i);
  f.polyWorldY = Float32Array.from(elevations);
  f.polyFlags = Uint8Array.from({ length: n }, () => 0);
  f.polyType = Uint16Array.from({ length: n }, () => 0);

  f.textContent = axes.map((a) => a.label);
  f.textAlignment = Array.from({ length: n }, () => 'center');
  f.textX = Float32Array.from(xs);
  f.textY = Float32Array.from({ length: n }, () => 0);
  f.textDirX = Float32Array.from({ length: n }, () => 1);
  f.textDirY = Float32Array.from({ length: n }, () => 0);
  f.textHeight = Float32Array.from({ length: n }, () => 1);
  f.textTargetPx = Float32Array.from({ length: n }, () => 0);
  f.textColor = new Float32Array(4 * n);
  f.textOwner = Uint32Array.from({ length: n }, (_, i) => 200 + i);
  f.textWorldY = Float32Array.from(elevations);
  f.textType = Uint16Array.from({ length: n }, () => 0);

  const fillPoints: number[] = [];
  const fillPointStart: number[] = [0];
  for (let i = 0; i < n; i++) {
    fillPoints.push(xs[i]!, 0, xs[i]!, 1, xs[i]! + 1, 1);
    fillPointStart.push(fillPointStart[i]! + 6);
  }
  f.fillPoints = Float32Array.from(fillPoints);
  f.fillPointStart = Uint32Array.from(fillPointStart);
  f.fillHoles = new Uint32Array(0);
  f.fillHoleStart = Uint32Array.from({ length: n + 1 }, () => 0);
  f.fillColor = new Float32Array(4 * n);
  f.fillHatch = new Float32Array(4 * n);
  f.fillOwner = Uint32Array.from({ length: n }, (_, i) => 300 + i);
  f.fillWorldY = Float32Array.from(elevations);
  f.fillFlags = Uint8Array.from({ length: n }, () => 0);
  f.fillType = Uint16Array.from({ length: n }, () => 0);

  return f;
}

function gridBubbleParse(axes?: readonly AxisOnStorey[]): ParseResult {
  return buildParseResult(gridBubbleFlat(axes), {});
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

describe('grid bubbles draw once, not once per storey (#5656)', () => {
  it('the fixture really does bucket the axis into three separate storeys', () => {
    const parsed = gridBubbleParse();
    assert.equal(parsed.gridByStorey.size, 3, 'one bucket per distinct elevation');
  });

  it('rich channel: only the lowest-elevation storey contributes a bubble text + fill', () => {
    const { texts, fills } = buildSymbolicRichChannels([{ cached: gridBubbleParse() }], GRID_ONLY);

    assert.equal(texts.length, 1, `expected exactly one bubble text, got ${texts.length}`);
    assert.equal(texts[0]!.content, '1');
    assert.equal(texts[0]!.origin[1], 0, 'the lowest of the three elevations (0, not 3000 or 6000)');

    assert.equal(fills.length, 1, `expected exactly one bubble fill, got ${fills.length}`);
    assert.equal(fills[0]!.worldY, 0);
  });

  it('line channel: every storey still contributes its grid line (lines are per-floor content)', () => {
    const { grid } = buildSymbolicLineChannels([{ cached: gridBubbleParse() }], GRID_ONLY);
    // Each of the 3 storeys' axis line is one 2-point segment == 6 floats
    // (x, y, z per point). Deduping bubbles must not touch this.
    assert.equal(vertexFloatCount(grid), 3 * 2 * 3, 'all three storeys’ grid lines are still present');
  });
});

describe('grid bubble dedup keeps what is not a duplicate (#5656)', () => {
  it('a section clip around an upper storey still shows that storey\'s copy', () => {
    const { texts, fills } = buildSymbolicRichChannels([{ cached: gridBubbleParse() }], {
      ...GRID_ONLY,
      clipEnabled: true,
      clipPos: 3000,
      clipDepth: 100,
    });
    assert.equal(texts.length, 1, 'the clipped-out lower copies must not hide the visible one');
    assert.equal(texts[0]!.origin[1], 3000);
    assert.equal(fills.length, 1);
    assert.equal(fills[0]!.worldY, 3000);
  });

  it('a label only an upper storey carries still draws', () => {
    const axes = [...DUPLICATED, { elevation: 6000, label: 'T1', x: 900 }];
    const { texts, fills } = buildSymbolicRichChannels([{ cached: gridBubbleParse(axes) }], GRID_ONLY);
    assert.deepEqual(texts.map((t) => [t.content, t.origin[1]]).sort(), [['1', 0], ['T1', 6000]]);
    assert.equal(fills.length, 2);
  });

  it('a hidden lowest copy hands the bubble to the next storey up', () => {
    // Text owners follow fixture order: ELEVATIONS[1] (0 mm) is owner 201.
    const { texts } = buildSymbolicRichChannels(
      [{ cached: gridBubbleParse(), isHidden: (id: number) => id === 201 }],
      GRID_ONLY,
    );
    assert.equal(texts.length, 1);
    assert.equal(texts[0]!.origin[1], 3000);
  });

  it('an unresolved-elevation (loose) copy does not stack on the storey copy', () => {
    // A NaN worldY never reaches a storey bucket; the parser sends it to the
    // loose list, lifted at fallbackY (0 here), where storey 0 already drew it.
    const axes = [NaN, 6000, 0, 3000].map((elevation) => ({ elevation, label: '1', x: AXIS_X }));
    const { texts } = buildSymbolicRichChannels([{ cached: gridBubbleParse(axes) }], GRID_ONLY);
    assert.equal(texts.length, 1);
    assert.equal(texts[0]!.origin[1], 0);
  });
});
