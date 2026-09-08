/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3368: two independent extractors both produced `IfcGridAxis` line
 * geometry for the 3D viewport, gated on the same `ifcGrid` toggle, and both
 * drew:
 *
 *  - `useSymbolicAnnotations` (backed by `rust/processing/src/symbolic/grid.rs`)
 *    section-clips its grid buckets against the active cut plane and applies
 *    the TS-side `originShift` elevation rebase (`elevationRebaseFor` in
 *    `symbolic-parse-cache.ts`) to every primitive, grid included — see
 *    `symbolic-parse.elevationFrame.test.ts`.
 *  - `useGridLines3D` (backed by `rust/wasm-bindings/src/api/grid_lines.rs`'s
 *    `parseGridLines`) drew the SAME axes unclipped and without that rebase.
 *
 * `Viewport.tsx` uploaded both as separate renderer line-overlay channels
 * ('annotation' and 'grid') whenever `ifcGridVisible` was on. Consequences:
 * every axis was drawn twice, issue #862's section-clipping of grid lines
 * was inert (the unclipped copy always drew the full grid), and for a
 * federated/re-aligned model with nonzero `originShift` the two copies sat
 * at different elevations.
 *
 * The fix collapses viewer grid-line ownership onto the symbolic path only
 * (already clip-aware and origin-shift-aware) and retires the redundant
 * `useGridLines3D` hook and its upload in `Viewport.tsx`. This test pins
 * that collapse structurally: it fails as long as a second, independent
 * grid-line source is wired into the viewport.
 *
 * Issue #3359 (issue #3359, PR #3381) split the surviving symbolic path's
 * output into `{ annotation, grid }` and gave grid content its own
 * renderer channel, separate from the bounds-expanding `annotation` channel
 * (see `useSymbolicAnnotations.gridChannelSplit.test.ts`). That split is
 * orthogonal to this test: this test is only about there being ONE grid-line
 * source, not about which channel it uploads to.
 *
 * `parseGridLines` / `parseGridAxes` themselves stay — they're published SDK
 * surface (`packages/geometry`) for embedders who want raw, unclipped grid
 * geometry with no annotation/storey semantics. This test is about the
 * VIEWER's internal wiring, not the wasm API.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildParseResult } from '../../lib/overlay-parse/symbolic-parse.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from '../../lib/overlay-parse/symbolic-flat.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(dir, '../../hooks/useGridLines3D.ts');
const mergePath = path.join(dir, 'merge-grid-line-channels.ts');

describe('grid line overlay has one owner (issue #3368)', () => {
  // A source-text regex against `Viewport.tsx` is refused by
  // `scripts/check-source-text-assertions.mjs` for new tests -- its escape
  // hatch is for anchor guards, which this is not. It would also be
  // redundant: both files below are deleted, so an import of either does
  // not compile and typecheck already enforces what a regex would have
  // asserted. What a text predicate could still catch -- a NEW second
  // line-overlay channel wired from somewhere else -- is left to the
  // file-absence checks below plus review.

  it('the redundant useGridLines3D hook has been retired', () => {
    assert.ok(
      !existsSync(hookPath),
      'useGridLines3D.ts still exists — it has no remaining call site once ' +
        'the viewer draws grid lines from a single (symbolic) owner, so it ' +
        'is dead code that could be re-wired back into a second draw path.',
    );
  });

  it('the now-empty merge step has been retired, not left with nothing to merge', () => {
    assert.ok(
      !existsSync(mergePath),
      'merge-grid-line-channels.ts still exists — with only one grid-line ' +
        'source left, a two-input merge function has nothing to merge and ' +
        'is dead code that could mask a second source being re-added.',
    );
  });
});

/**
 * Consequence 3 (issue #3368): "the copies can disagree in Y". Quantify the
 * mechanism directly from the real code both sides used.
 *
 *  - The surviving (symbolic) path bucketed a grid axis's `worldY` through
 *    `buildParseResult`'s `ensureBucket`, which subtracts
 *    `elevationRebase.primitive` — the TS-side `originShift` component
 *    (`elevationRebaseFor` in `symbolic-parse-cache.ts`) that a wasm
 *    primitive never carries, since the wasm extractor only ever removes the
 *    RTC Z (`rust/processing/src/symbolic/rebase.rs`).
 *  - The retired raw path (`useGridLines3D` -> wasm `parseGridLines`) handed
 *    that same RTC-only `worldY` straight to `renderer.setLineOverlay('grid', ...)`
 *    with NO further processing: `useGridLines3D.ts` (now deleted) never
 *    referenced `elevationRebase`/`originShift`/`totalYupOffset`, and neither
 *    did the `Viewport.tsx` effect that used to upload its output.
 *
 * A federated/re-aligned model sets a nonzero `originShift`, so
 * `elevationRebase.primitive !== 0`, and the two Y values genuinely diverge —
 * this is not hypothetical. A model needing no rebase (`primitive === 0`,
 * the fixture's second case) hides the bug by accident, which is exactly why
 * origin-frame symmetry must be avoided when reproducing this class of
 * defect.
 */
describe('the two owners disagreed in Y for a re-aligned model (issue #3368)', () => {
  const RTC_ONLY_WORLD_Y = 12.5; // wasm primitive.worldY: RTC Z already removed, nothing else.
  const ORIGIN_SHIFT_Y = 3.75; // originShift.y for a re-aligned/federated model.

  function flatWithOneGridAxis(worldY: number): FlatSymbolic {
    const flat = createEmptyFlatSymbolic();
    flat.typeNames = ['IfcGridAxis'];
    flat.polyPoints = Float32Array.from([0, 0, 10, 0]);
    flat.polyStart = Uint32Array.from([0, 2]);
    flat.polyOwner = Uint32Array.from([7]);
    flat.polyWorldY = Float32Array.from([worldY]);
    flat.polyFlags = Uint8Array.from([0]);
    flat.polyType = Uint16Array.from([0]);
    return flat;
  }

  it('a nonzero originShift moves the symbolic (clipped) copy away from the raw (unclipped) one', () => {
    const result = buildParseResult(flatWithOneGridAxis(RTC_ONLY_WORLD_Y), {
      elevationRebase: { primitive: ORIGIN_SHIFT_Y, storeyTable: ORIGIN_SHIFT_Y },
    });
    const buckets = [...result.gridByStorey.values()];
    assert.strictEqual(buckets.length, 1, 'one grid axis makes one bucket');
    const symbolicY = buckets[0].storeyElevation;
    assert.ok(symbolicY !== null);
    // The retired raw path returned RTC_ONLY_WORLD_Y verbatim -- no rebase.
    const rawPathY = RTC_ONLY_WORLD_Y;
    assert.ok(
      Math.abs((symbolicY as number) - rawPathY) > 1e-6,
      `the symbolic bucket (${symbolicY}) must diverge from the raw path's ` +
        `unrebased value (${rawPathY}) by the origin shift (${ORIGIN_SHIFT_Y}), ` +
        "reproducing #3368's \"copies can disagree in Y\"",
    );
    assert.ok(
      Math.abs((symbolicY as number) - (rawPathY - ORIGIN_SHIFT_Y)) < 1e-6,
      `expected symbolic Y = raw Y - originShift.y = ${rawPathY - ORIGIN_SHIFT_Y}, got ${symbolicY}`,
    );
  });

  it('a model needing no rebase hides the divergence by accident (why symmetry must be avoided)', () => {
    const result = buildParseResult(flatWithOneGridAxis(RTC_ONLY_WORLD_Y), {
      elevationRebase: { primitive: 0, storeyTable: 0 },
    });
    const buckets = [...result.gridByStorey.values()];
    const symbolicY = buckets[0].storeyElevation;
    assert.ok(
      Math.abs((symbolicY as number) - RTC_ONLY_WORLD_Y) < 1e-6,
      'with no origin shift the two paths coincidentally agree -- this is the ' +
        'symmetric case the reproduction must not rely on',
    );
  });
});
