/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `formatDistance()` ignoring `unitDisplayOverrides` — issue #2199,
 * maintainer's "worth its own small fix" note. A user who has set feet as
 * the LENGTHUNIT display override still got metres from every measure-tool
 * distance readout; #2514 only wired the override through
 * `resolveQuantityDisplay` for element quantities (area/volume/weight), not
 * for the distances the measure tool itself produces.
 *
 * `formatDistance` is the single distance formatter — the maintainer's deep
 * review on #2538 flagged that a separate `formatDistanceDisplay` beside an
 * unconditionally-metric `formatDistance` left every measure-tool call site
 * free to pick either name and silently get an unconverted result. The
 * override handling was folded into `formatDistance` itself instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatDistance, formatSignedTriple, formatSplitHoverLabel } from './formatDistance.js';

describe('formatDistance', () => {
  it('falls back to the auto-scaled metric string when overrides is omitted', () => {
    assert.strictEqual(formatDistance(3), '3.000 m');
    assert.strictEqual(formatDistance(0.25), '25.0 cm');
  });

  it('falls back to the auto-scaled metric string when no override is set', () => {
    assert.strictEqual(formatDistance(3, {}), formatDistance(3));
    assert.strictEqual(formatDistance(0.25, {}), formatDistance(0.25));
  });

  it('falls back when overrides carries an unrelated unit type', () => {
    assert.strictEqual(formatDistance(6.824, { AREAUNIT: 'ft2' }), formatDistance(6.824));
  });

  it('converts into the LENGTHUNIT override instead of auto-scaled metric', () => {
    // 1 m3 cube edge from the maintainer's own verification numbers: 1.000 m
    // measured, which at 3.28084 ft/m is 3.2808 ft, capped to 4 fraction
    // digits by formatConverted.
    assert.strictEqual(formatDistance(1, { LENGTHUNIT: 'ft' }), '3.2808 ft');
  });

  it('converts a sub-metre distance the same way the auto-scaled path would have shown as cm', () => {
    // 0.25 m -> the no-override path says "25.0 cm"; the override must win
    // instead of the auto cm/mm scaling.
    assert.strictEqual(formatDistance(0.25, { LENGTHUNIT: 'ft' }), '0.8202 ft');
  });

  it('converts into the millimetre override', () => {
    // Kept under 1000 so a locale's thousands-separator can't make this
    // assertion flaky — formatConverted's grouping is exercised separately
    // in lib/units/display.test.ts.
    assert.strictEqual(formatDistance(0.00125, { LENGTHUNIT: 'mm' }), '1.25 mm');
  });
});

// #2538 deep review: MeasurePointReadout's relative row converted only its
// trailing distance hint, leaving the X/Y/Z triple beside it in unlabelled
// metres — a `ft` override made the row read a metre triple next to a feet
// distance. `formatSignedTriple` is the fix: the same LENGTHUNIT conversion
// `formatDistance` applies to the hint, applied per axis to the triple.
describe('formatSignedTriple', () => {
  it('keeps unlabelled metres when overrides is omitted', () => {
    assert.strictEqual(
      formatSignedTriple({ x: 1, y: 2, z: 3 }),
      'ΔX +1.000  ΔY +2.000  ΔZ +3.000',
    );
  });

  it('keeps unlabelled metres for an empty override map', () => {
    assert.strictEqual(
      formatSignedTriple({ x: 1, y: 2, z: 3 }, {}),
      'ΔX +1.000  ΔY +2.000  ΔZ +3.000',
    );
  });

  it('converts every axis into the LENGTHUNIT override, matching formatDistance per axis', () => {
    // 1 m -> 3.2808 ft, 2 m -> 6.5617 ft, 3 m -> 9.8425 ft (3.28084 ft/m).
    assert.strictEqual(
      formatSignedTriple({ x: 1, y: 2, z: 3 }, { LENGTHUNIT: 'ft' }),
      'ΔX +3.2808  ΔY +6.5617  ΔZ +9.8425',
    );
  });

  it('keeps negative axes signed after conversion, and leaves a zero axis unsigned', () => {
    assert.strictEqual(
      formatSignedTriple({ x: -1, y: 0, z: 3.048 }, { LENGTHUNIT: 'ft' }),
      'ΔX -3.2808  ΔY 0  ΔZ +10',
    );
  });

  it('marks every axis as a delta, so the triple cannot be read as a position (#2737 §3)', () => {
    // The acceptance criterion — *a relative coordinate is visually distinct
    // from an absolute one* — held in the value itself, not in the row label
    // beside it. The four absolute kinds the viewer prints (model-local,
    // project/anchor, render-frame world, georeferenced) all render as
    // `X … Y … Z …`; this must never collide with that shape, whatever the
    // unit or the sign.
    for (const [p, overrides] of [
      [{ x: 1, y: 2, z: 3 }, {}],
      [{ x: -1, y: 0, z: 3.048 }, { LENGTHUNIT: 'ft' }],
      [{ x: 0, y: 0, z: 0 }, { LENGTHUNIT: 'mm' }],
    ] as const) {
      const out = formatSignedTriple(p, overrides);
      assert.doesNotMatch(out, /(^|\s)X /, `a delta triple printed like a position: "${out}"`);
      assert.match(out, /^ΔX .*ΔY .*ΔZ /, `axis markers missing: "${out}"`);
    }
  });

  it('gives a zero offset no direction', () => {
    // `+0.000` claims a direction an offset of nothing does not have.
    assert.strictEqual(formatSignedTriple({ x: 0, y: 0, z: 0 }), 'ΔX 0.000  ΔY 0.000  ΔZ 0.000');
  });
});

// `SplitOverlay`'s live "distance / length" hover label hardcoded
// `${distance.toFixed(2)} / ${length.toFixed(2)} m`, the exact shape #2199's
// maintainer note already found and fixed once for `formatDistance` itself
// (see this module's docstring): every other measure-tool readout in this
// panel honors the LENGTHUNIT display override, but the Split tool's guide
// line kept reporting raw, unconverted metres regardless of it.
describe('formatSplitHoverLabel', () => {
  // NOT the pre-fix shape: the old label was `toFixed(2)` raw metres
  // ("1.50 / 4.00 m"). Routing through formatDistance adopts the panel's
  // auto-scaled convention instead, so the no-override rendering changes too
  // — including switching to mm/cm for small values. That alignment is the
  // point of the fix, but it is a visible change, not a no-op.
  it('renders unlabelled metres in the panel\'s auto-scaled form when overrides is omitted', () => {
    assert.strictEqual(formatSplitHoverLabel(1.5, 4), '1.500 / 4.000 m');
  });

  it('keeps unlabelled metres for an empty override map', () => {
    assert.strictEqual(formatSplitHoverLabel(1.5, 4, {}), '1.500 / 4.000 m');
  });

  it('converts BOTH numbers into the LENGTHUNIT override, sharing one trailing unit', () => {
    // 1.5 m -> 4.9213 ft, 4 m -> 13.1234 ft (3.28084 ft/m, formatConverted's
    // 4-fraction-digit cap) — the same per-value conversion `formatDistance`
    // applies, not the pre-fix raw metres.
    assert.strictEqual(
      formatSplitHoverLabel(1.5, 4, { LENGTHUNIT: 'ft' }),
      '4.9213 / 13.1234 ft',
    );
  });
});
