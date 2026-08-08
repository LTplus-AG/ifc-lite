/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GeometryDiagnostics } from '@ifc-lite/geometry';
import { buildModelLoadedGeometryProps } from './modelLoadedGeometryProps.js';

function diag(over: Partial<GeometryDiagnostics> = {}): GeometryDiagnostics {
  return {
    schemaVersion: 1,
    totalCsgFailures: 0,
    productsWithFailures: 0,
    hostsWithOpenings: 0,
    classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
    failuresByReason: [],
    silentNoOps: 0,
    rectFast: {
      fired: 0,
      openingsCut: 0,
      deferHostNotBox: 0,
      deferNotThrough: 0,
      deferOffFace: 0,
      deferNearEdge: 0,
      deferNoOpenings: 0,
    },
    worstHosts: [],
    ...over,
  };
}

describe('buildModelLoadedGeometryProps (#2388 attribution)', () => {
  it('reports the CSG failure counts the streaming complete event carried', () => {
    const props = buildModelLoadedGeometryProps({
      diagnostics: diag({ totalCsgFailures: 7, productsWithFailures: 3, silentNoOps: 2 }),
      tessellationTier: 'low',
      skipSmallCuts: true,
    });
    assert.equal(props.total_csg_failures, 7);
    assert.equal(props.csg_products_with_failures, 3);
    assert.equal(props.csg_silent_no_ops, 2);
  });

  it('leaves the CSG counts UNSET when no producer emitted diagnostics', () => {
    // The whole point of #2388: a fabricated 0 would read as "CSG ruled out"
    // on a load where the counter simply never arrived. Absent must stay absent.
    for (const d of [undefined, null]) {
      const props = buildModelLoadedGeometryProps({
        diagnostics: d,
        tessellationTier: undefined,
        skipSmallCuts: true,
      });
      assert.equal(props.total_csg_failures, undefined);
      assert.equal(props.csg_products_with_failures, undefined);
      assert.equal(props.csg_silent_no_ops, undefined);
    }
  });

  it('records a real zero as zero (a clean load is not an absent load)', () => {
    const props = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: 'lowest',
      skipSmallCuts: false,
    });
    assert.equal(props.total_csg_failures, 0);
  });

  it('records the two fidelity inputs that change triangles without changing the mesh roster', () => {
    // `skipSmallCuts` drops sub-ratio boolean cutters (host rendered un-cut) and
    // a Lowest/Low tier does the same plus coarsens curves — neither increments
    // `totalCsgFailures`, so without these fields a load that differs ONLY by
    // them is indistinguishable from a byte-identical one.
    const fast = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: 'low',
      skipSmallCuts: true,
    });
    assert.equal(fast.tessellation_tier, 'low');
    assert.equal(fast.skip_small_cuts, true);

    const exact = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: undefined,
      skipSmallCuts: false,
    });
    // `undefined` from resolveLoadTessellationTier IS the engine default, and it
    // must be reported as such — not as an absent field indistinguishable from
    // an older build that never sent one.
    assert.equal(exact.tessellation_tier, 'medium');
    assert.equal(exact.skip_small_cuts, false);
  });

  it('reports the dominant failure reason so a nonzero count is actionable', () => {
    const props = buildModelLoadedGeometryProps({
      diagnostics: diag({
        totalCsgFailures: 5,
        failuresByReason: [
          { reason: 'OperandTooLarge', count: 4 },
          { reason: 'EmptyOperand', count: 1 },
        ],
      }),
      tessellationTier: undefined,
      skipSmallCuts: true,
    });
    assert.equal(props.csg_top_failure_reason, 'OperandTooLarge');
  });

  it('omits the top reason when nothing failed', () => {
    const props = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: undefined,
      skipSmallCuts: true,
    });
    assert.equal(props.csg_top_failure_reason, undefined);
  });
});

describe('ifc_model_loaded wiring (#2388)', () => {
  // A unit test of the builder cannot catch it being disconnected from the
  // capture — which is the failure that silently restores the blind spot this
  // change exists to remove. Same rationale as `beforeSend`'s pipeline test in
  // lib/analytics.ts.
  const src = readFileSync(
    fileURLToPath(new URL('./useIfcLoader.ts', import.meta.url)),
    'utf8',
  );

  it('spreads the builder into the wasm-path ifc_model_loaded capture', () => {
    assert.match(src, /\.\.\.buildModelLoadedGeometryProps\(/);
  });

  it('feeds the builder the diagnostics captured on the streaming complete event', () => {
    assert.match(src, /loadDiagnostics = event\.diagnostics/);
  });
});
