/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The grid section-clip band, issue #862, finally under test — issue #3393.
 *
 * Grid content is clipped to the active section slab; IfcAnnotation content
 * deliberately is not. Both halves of that rule (`buildSymbolicLineChannels`
 * for the line buffers, `buildSymbolicRichChannels` for the texts and fills)
 * gate a `gridByStorey` walk on `y < lo || y > hi`, and nothing in the repo
 * passed `gridSectionClip` outside `Viewport.tsx`, so `clipEnabled === true`
 * had never been reached by a test.
 *
 * ## Why the previous attempt asserted nothing
 *
 * In-band / out-of-band cases were added at the HOOK level over the fixture in
 * `useSymbolicAnnotations.gridBubbleExtent.test.tsx`. They passed, and they
 * passed with both band checks deleted.
 *
 * The cause is NOT the band check and NOT the parse routing, both of which are
 * correct. It is that the helper's way of choosing a fixture — re-install the
 * worker stub, then mount — is not a fixture-selection mechanism at all.
 * `symbolic-parse-cache.ts` keys its module-global cache on
 * `source.contentKey` plus the elevation rebase, and `ensureParseFor` returns
 * early when that key is already cached or in flight. Every fixture variant
 * shared one `contentKey`, so the second parse of a test was answered from the
 * first fixture and the freshly installed worker was never asked anything.
 *
 * With the default NaN-world-Y fixture reused, `ensureBucket`
 * (`lib/overlay-parse/symbolic-parse.ts`, the `Number.isFinite` branch) routes
 * every grid primitive to `gridLoose` / `gridLooseTexts` / `gridLooseFills`.
 * `gridByStorey` is then EMPTY, the band check is a guard inside a
 * zero-iteration loop, and the only guard that runs is the loose one,
 * `fallbackY >= lo && fallbackY <= hi`. Deleting the band check cannot change
 * a result it never touched.
 *
 * Measured, not reasoned: instrumenting the stub showed the second `sample()`
 * of a test issuing no worker request at all, and the fixture's `contentKey`
 * now carries the fixture so that cannot recur.
 *
 * ## What this file does differently
 *
 * 1. It builds the fixture through the REAL `buildParseResult`, then asserts
 *    `gridByStorey` is populated DIRECTLY (first test) rather than inferring
 *    it from a downstream buffer. That is the check whose absence let the
 *    previous attempt ship a vacuous pair.
 * 2. The fixture is MIXED: one grid axis at a resolvable elevation
 *    (`BUCKET_Y`, so it lands in `gridByStorey`) and one with a NaN elevation
 *    (so it lands in `gridLoose*` at `fallbackY`). The two guards therefore
 *    have separate, observable populations.
 * 3. Both clip bands admit exactly one of the two. Neither expected result is
 *    "empty", so no case can pass by everything having been filtered out
 *    somewhere upstream — the failure that hid inside the previous attempt.
 * 4. It runs against the pure seams #3381 cut, so there is no React tree, no
 *    overlay worker stub and no module-global parse cache between the fixture
 *    and the branch under test. That removes the whole mechanism above rather
 *    than working around it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolicLineChannels } from './symbolic-line-channels.js';
import { buildSymbolicRichChannels } from './symbolic-rich-channels.js';
import {
  buildParseResult,
  createEmptyFlatSymbolic,
  type FlatSymbolic,
  type ParseResult,
} from '../lib/overlay-parse/symbolic-parse.js';

/** Elevation of the grid axis that resolves to a storey bucket. */
const BUCKET_Y = 10;
/** World Y the hook lifts orphan (loose) content to. */
const FALLBACK_Y = 0;
/** X of the bucket-routed axis, so it is identifiable by coordinate. */
const BUCKET_X = 1000;
/** X of the loose axis. */
const LOOSE_X = 2000;

/**
 * Two IfcGridAxis primitives of each kind (line, text, fill): one carrying a
 * finite world-Y (→ `gridByStorey`), one carrying NaN (→ `gridLoose*`).
 *
 * `ensureBucket` routes on `Number.isFinite(primitiveWorldY)`, so the finite
 * value is the whole reason the first half reaches the band check at all.
 */
function mixedGridFlat(): FlatSymbolic {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcGridAxis'];

  f.polyPoints = Float32Array.from([
    BUCKET_X, 0, BUCKET_X, 1,
    LOOSE_X, 0, LOOSE_X, 1,
  ]);
  f.polyStart = Uint32Array.from([0, 2, 4]);
  f.polyOwner = Uint32Array.from([11, 12]);
  f.polyWorldY = Float32Array.from([BUCKET_Y, NaN]);
  f.polyFlags = Uint8Array.from([0, 0]);
  f.polyType = Uint16Array.from([0, 0]);

  f.textContent = ['BUCKET', 'LOOSE'];
  f.textAlignment = ['center', 'center'];
  f.textX = Float32Array.from([BUCKET_X, LOOSE_X]);
  f.textY = Float32Array.from([0, 0]);
  f.textDirX = Float32Array.from([1, 1]);
  f.textDirY = Float32Array.from([0, 0]);
  f.textHeight = Float32Array.from([1, 1]);
  f.textTargetPx = Float32Array.from([0, 0]);
  f.textColor = new Float32Array(8);
  f.textOwner = Uint32Array.from([11, 12]);
  f.textWorldY = Float32Array.from([BUCKET_Y, NaN]);
  f.textType = Uint16Array.from([0, 0]);

  // Offsets index FLOATS in fillPoints (the reader slices start[i]..start[i+1]),
  // so three [x, z] pairs is six floats per fill.
  f.fillPoints = Float32Array.from([
    BUCKET_X, 0, BUCKET_X, 1, BUCKET_X + 1, 1,
    LOOSE_X, 0, LOOSE_X, 1, LOOSE_X + 1, 1,
  ]);
  f.fillPointStart = Uint32Array.from([0, 6, 12]);
  f.fillHoles = new Uint32Array(0);
  f.fillHoleStart = Uint32Array.from([0, 0, 0]);
  f.fillColor = new Float32Array(8);
  f.fillHatch = new Float32Array(8);
  f.fillOwner = Uint32Array.from([11, 12]);
  f.fillWorldY = Float32Array.from([BUCKET_Y, NaN]);
  f.fillFlags = Uint8Array.from([0, 0]);
  f.fillType = Uint16Array.from([0, 0]);

  return f;
}

function mixedGridParse(): ParseResult {
  return buildParseResult(mixedGridFlat(), {});
}

/** Band that admits `BUCKET_Y` and excludes `FALLBACK_Y`. */
const BAND_OVER_BUCKET = { clipEnabled: true, clipPos: BUCKET_Y, clipDepth: 1 };
/** Band that admits `FALLBACK_Y` and excludes `BUCKET_Y`. */
const BAND_OVER_FALLBACK = { clipEnabled: true, clipPos: FALLBACK_Y, clipDepth: 1 };

const GRID_ONLY = { enabled: false, effectiveGridEnabled: true, fallbackY: FALLBACK_Y };

/** Every x coordinate in a flat `[x, y, z, …]` line list. */
function xs(buffer: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < buffer.length; i += 3) out.push(buffer[i]);
  return out;
}

describe('the grid section-clip band filters gridByStorey buckets (issues #862, #3393)', () => {
  it('the fixture puts grid content in gridByStorey, not only in the loose buckets', () => {
    // Asserted DIRECTLY on the parse, not inferred from a channel buffer.
    // The previous attempt's fixture failed exactly here and nothing said so:
    // every primitive sat in gridLoose*, the band check guarded an empty walk,
    // and both in-band and out-of-band came back empty either way (#3393).
    const parsed = mixedGridParse();

    assert.equal(parsed.gridByStorey.size, 1, 'one storey bucket must exist for the band check to filter');
    const bucket = [...parsed.gridByStorey.values()][0];
    assert.equal(bucket.storeyElevation, BUCKET_Y, 'and it must sit at the elevation the bands are built around');
    assert.equal(bucket.lines.length, 1, 'the bucket carries the line half');
    assert.equal(bucket.texts.length, 1, 'the bucket carries the text half');
    assert.equal(bucket.fills.length, 1, 'the bucket carries the fill half');

    // The other half of the mix, so the two guards address disjoint content.
    assert.equal(parsed.gridLoose.length, 1);
    assert.equal(parsed.gridLooseTexts.length, 1);
    assert.equal(parsed.gridLooseFills.length, 1);

    // Nothing may reach the IfcAnnotation collections: an axis leaking there
    // would be lifted unclipped and the band would be bypassed entirely.
    assert.equal(parsed.byStorey.size, 0);
    assert.equal(parsed.loose.length, 0);
  });

  it('line channel: a band over the bucket admits the bucket axis and drops the loose one', () => {
    const { grid } = buildSymbolicLineChannels([{ cached: mixedGridParse() }], {
      ...GRID_ONLY,
      ...BAND_OVER_BUCKET,
    });

    assert.deepEqual(xs(grid), [BUCKET_X, BUCKET_X], 'only the in-band bucket axis lifts');
  });

  it('line channel: a band that excludes the bucket drops it and keeps only the loose axis', () => {
    // The discriminating case for `y < lo || y > hi`. The expected result is
    // NON-empty on purpose: an empty expectation is satisfied by the content
    // never arriving, which is how the previous attempt passed with the band
    // check deleted.
    const { grid } = buildSymbolicLineChannels([{ cached: mixedGridParse() }], {
      ...GRID_ONLY,
      ...BAND_OVER_FALLBACK,
    });

    assert.deepEqual(
      xs(grid),
      [LOOSE_X, LOOSE_X],
      'the out-of-band bucket axis must not lift; deleting the band check puts BUCKET_X back here',
    );
  });

  it('rich channel: a band over the bucket admits the bucket bubble and drops the loose one', () => {
    const { texts, fills } = buildSymbolicRichChannels([{ cached: mixedGridParse() }], {
      ...GRID_ONLY,
      ...BAND_OVER_BUCKET,
    });

    assert.deepEqual(texts.map((t) => t.content), ['BUCKET']);
    assert.deepEqual(texts.map((t) => t.worldPos[1]), [BUCKET_Y], 'lifted to its own storey, not the fallback');
    assert.deepEqual(fills.map((f) => f.worldY), [BUCKET_Y]);
  });

  it('rich channel: a band that excludes the bucket drops it and keeps only the loose bubble', () => {
    // The rich half's own copy of the band check — a separate walk from the
    // line half above, so it needs its own red.
    const { texts, fills } = buildSymbolicRichChannels([{ cached: mixedGridParse() }], {
      ...GRID_ONLY,
      ...BAND_OVER_FALLBACK,
    });

    assert.deepEqual(
      texts.map((t) => t.content),
      ['LOOSE'],
      'the out-of-band bucket bubble must not lift; deleting the band check puts BUCKET back here',
    );
    assert.deepEqual(fills.map((f) => f.worldY), [FALLBACK_Y]);
  });

  it('with no clip active, both bands and both buckets lift — the clip is what filters', () => {
    // Pins that the filtering above is the CLIP doing it, not the fixture:
    // the same parse with `clipEnabled: false` yields everything.
    const params = { ...GRID_ONLY, clipEnabled: false, clipPos: 0, clipDepth: 0 };
    const { grid } = buildSymbolicLineChannels([{ cached: mixedGridParse() }], params);
    const { texts } = buildSymbolicRichChannels([{ cached: mixedGridParse() }], params);

    assert.deepEqual(xs(grid).sort((a, b) => a - b), [BUCKET_X, BUCKET_X, LOOSE_X, LOOSE_X]);
    assert.deepEqual([...texts.map((t) => t.content)].sort(), ['BUCKET', 'LOOSE']);
  });

  it('IfcAnnotation content is never clipped, only grid content is (issue #862)', () => {
    // The rule the band belongs to. An annotation bucket at the same excluded
    // elevation still lifts, so a band check copy-pasted onto `byStorey` would
    // fail here rather than pass quietly.
    //
    // Asserted on BOTH builders. Each keeps its own `byStorey` walk, so the
    // line assertion says nothing about the rich one: pasting a band check into
    // `symbolic-rich-channels.ts` alone hides every label and fill on an
    // out-of-slab storey while the line channel stays green.
    const flat = mixedGridFlat();
    flat.typeNames = ['IfcAnnotation'];
    const cached = buildParseResult(flat, {});
    assert.equal(cached.byStorey.size, 1, 'the fixture must reach the annotation buckets for this to mean anything');

    const params = {
      enabled: true,
      effectiveGridEnabled: true,
      fallbackY: FALLBACK_Y,
      ...BAND_OVER_FALLBACK,
    };

    const { annotation } = buildSymbolicLineChannels([{ cached }], params);
    assert.deepEqual(
      xs(annotation).sort((a, b) => a - b),
      [BUCKET_X, BUCKET_X, LOOSE_X, LOOSE_X],
      'the annotation line channel ignores the section band entirely',
    );

    const { texts, fills } = buildSymbolicRichChannels([{ cached }], params);
    assert.deepEqual(
      [...texts.map((t) => t.content)].sort(),
      ['BUCKET', 'LOOSE'],
      'and so does the annotation text channel; BUCKET sits outside the band',
    );
    assert.deepEqual(
      [...fills.map((f) => f.worldY)].sort((a, b) => a - b),
      [FALLBACK_Y, BUCKET_Y],
      'and the fill channel, on its own walk again',
    );
  });
});
