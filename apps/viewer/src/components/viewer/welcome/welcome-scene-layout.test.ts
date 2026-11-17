/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start screen's 3D mark is decorative, but its geometry still has to be
 * the logo: four extrusions, cut into three layer bands with nothing lost or
 * doubled at the cuts. The three.js half cannot run here (no WebGL), so the
 * slicing it renders is pinned instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_BANDS, MAX_LAYER_GAP, blockTag, explodeAt, sliceLogoIntoBands } from './welcome-scene-layout.js';

describe('welcome scene layout', () => {
  it('slices the four extrusions into 4, 3 and 1 boxes per band', () => {
    assert.deepEqual(sliceLogoIntoBands().map((band) => band.length), [4, 3, 1]);
  });

  it('keeps every box inside its band and loses no height at the cuts', () => {
    const bands = sliceLogoIntoBands();
    bands.forEach((band, k) => {
      const [lo, hi] = LAYER_BANDS[k];
      for (const box of band) {
        assert.ok(box.y - box.height / 2 >= lo - 1e-9 && box.y + box.height / 2 <= hi + 1e-9);
      }
    });
    // Total extruded height across bands equals the logo's: 3.2 + 2.2 + 2.2 + 1.2.
    const total = bands.flat().reduce((sum, box) => sum + box.height, 0);
    assert.ok(Math.abs(total - 8.8) < 1e-9, `expected 8.8, got ${total}`);
  });

  it('centres the mark on the origin in plan', () => {
    const xs = sliceLogoIntoBands()[0].map((box) => box.x);
    assert.ok(Math.abs(Math.min(...xs) + Math.max(...xs)) < 1e-9);
  });

  it('marks only the inner cuts, never a column\'s own ends', () => {
    const [base, middle, top] = sliceLogoIntoBands();
    assert.ok(base.every((b) => !b.cutBelow), 'nothing is cut below the ground layer');
    assert.ok(middle.every((b) => b.cutBelow), 'the middle layer always sits on a cut');
    // The tower is the only column that reaches the top layer, and ends there.
    assert.deepEqual(top.map((b) => [b.column, b.cutBelow, b.cutAbove]), [[0, true, false]]);
    // The plinth (1.2 m) ends exactly at the first cut: its top is its own end.
    assert.equal(base.find((b) => b.column === 3)?.cutAbove, false);
  });

  it('spends the cycle mostly assembled or apart, easing between', () => {
    assert.equal(explodeAt(0), 0, 'starts as the assembled logo');
    assert.equal(explodeAt(6), 1, 'holds fully apart mid-cycle');
    const samples = Array.from({ length: 400 }, (_, i) => explodeAt(i * 0.0249));
    assert.ok(samples.every((f) => f >= 0 && f <= 1));
    const ends = samples.filter((f) => f === 0 || f === 1).length;
    assert.ok(ends / samples.length > 0.6, 'most of the cycle rests at an end');
    assert.ok(MAX_LAYER_GAP < 1, 'layers stay close enough to read as the logo');
  });
});

describe('welcome scene hover tags', () => {
  it('describes each sliced box by its column and layer', () => {
    const tag = blockTag(2, 0);
    assert.equal(tag.name, 'Tower');
    assert.equal(tag.layerFile, 'tower.ifcx');
    assert.equal(tag.layerCount, 3);
    assert.ok(Math.abs(tag.height - 1) < 1e-9);
    assert.equal(tag.columnHeight, 3.2);
    assert.match(tag.globalId, /^[0-9A-Za-z_$]{22}$/);
  });

  it('gives every column its own GlobalId', () => {
    const ids = new Set([0, 1, 2, 3].map((c) => blockTag(0, c).globalId));
    assert.equal(ids.size, 4);
  });
});
