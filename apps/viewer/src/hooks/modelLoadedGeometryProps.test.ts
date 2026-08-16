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

/**
 * Strip `//` line comments. Without this, a source-text assertion is
 * satisfiable by a comment that merely quotes the call it's supposed to be
 * pinning (see `SearchModal.filter.wiring.test.ts` for the mutation that
 * caught exactly this) — so a comment-only decoy would pass alongside, or
 * instead of, the real call.
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * The argument list of the wasm-path `captureModelLoaded(…)` call — a
 * balanced-paren extraction anchored on `...buildModelLoadedPayload(`, which
 * is unique in this file (the import line reads `buildModelLoadedPayload }`,
 * with no following paren) and is a call this PR does not touch, so it
 * survives mutation of the `buildModelLoadedGeometryProps` wiring under test.
 * Matching against this span only — rather than the whole file — means the
 * assertion can't be satisfied by a comment, an import line, or one of the
 * other five `ifc_model_loaded` capture sites in this file that don't carry
 * geometry diagnostics.
 *
 * Anchored on `captureModelLoaded(`, not `posthog.capture(`: `posthog.capture`
 * for this event is private to `loadTelemetry.ts` (#2624) — every call site
 * in this file, including the wasm path, goes through `captureModelLoaded`.
 */
function wasmCaptureArgs(): string {
  const src = stripLineComments(
    readFileSync(fileURLToPath(new URL('./useIfcLoader.ts', import.meta.url)), 'utf8'),
  );
  const payloadSpreadIdx = src.indexOf('...buildModelLoadedPayload(');
  assert.notEqual(payloadSpreadIdx, -1, 'buildModelLoadedPayload must be spread somewhere in useIfcLoader.ts');
  const callStart = src.lastIndexOf('captureModelLoaded(', payloadSpreadIdx);
  assert.notEqual(callStart, -1, 'the buildModelLoadedPayload spread must sit inside a captureModelLoaded(...) call');
  const argsOpen = callStart + 'captureModelLoaded('.length - 1; // index of the call's own `(`
  assert.equal(src[argsOpen], '(');
  let depth = 0;
  let argsClose = -1;
  for (let i = argsOpen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) {
        argsClose = i;
        break;
      }
    }
  }
  assert.notEqual(argsClose, -1, 'the posthog.capture(...) call must have a matching close paren');
  return src.slice(argsOpen + 1, argsClose);
}

describe('ifc_model_loaded wiring (#2388)', () => {
  // A unit test of the builder cannot catch it being disconnected from the
  // capture — which is the failure that silently restores the blind spot this
  // change exists to remove. Same rationale as `beforeSend`'s pipeline test in
  // lib/analytics.ts.
  //
  // Scoped to the wasm-path capture's own argument list (not "anywhere in the
  // module"): a whole-file `indexOf`/`match` would also pass if the spread and
  // its fields showed up in a comment, an unrelated call, or a different one
  // of the six `ifc_model_loaded` capture sites in this file.
  const src = readFileSync(
    fileURLToPath(new URL('./useIfcLoader.ts', import.meta.url)),
    'utf8',
  );

  it('spreads the builder, wired to the load diagnostics and fidelity inputs, into the wasm-path ifc_model_loaded capture', () => {
    const args = wasmCaptureArgs();
    assert.match(args, /\.\.\.buildModelLoadedGeometryProps\(/);
    for (const field of [
      'diagnostics: loadDiagnostics',
      'tessellationTier: loadTessellationTier',
      'skipSmallCuts: skipSmallCutsAtLoad',
    ]) {
      assert.ok(
        args.includes(field),
        `wasm-path ifc_model_loaded capture must pass ${field} to buildModelLoadedGeometryProps`,
      );
    }
  });

  it('feeds the builder the diagnostics captured on the streaming complete event', () => {
    assert.match(src, /loadDiagnostics = event\.diagnostics/);
  });
});

describe('ifc_model_loaded cache-hit geometry props (#2388)', () => {
  // The cache-hit WIRING is tested behaviourally, not by source text:
  // `useIfcLoader.cacheHitTelemetry.test.tsx` seeds a real cache entry, drives
  // the real `loadFile` to a real hit, and reads the `ifc_model_loaded` event
  // that actually leaves `posthog.capture`. That path is reachable under
  // `tsx --test` (the hit is decided at `loadStage = 'cache-lookup'`, long
  // before the wasm engine is touched), so no source-text stand-in is needed
  // here — unlike the wasm-path wiring above. What remains below is the
  // builder-level half of the same contract.

  it('reports absent CSG counters alongside real fidelity values for a cache hit (builder-level proof)', () => {
    // Mirrors the exact call shape the cache-hit site should use: no
    // diagnostics available (hence `undefined`), but real tier/skip values.
    const props = buildModelLoadedGeometryProps({
      diagnostics: undefined,
      tessellationTier: 'low',
      skipSmallCuts: true,
    });
    assert.equal(props.tessellation_tier, 'low');
    assert.equal(props.skip_small_cuts, true);
    assert.equal(props.total_csg_failures, undefined);
    assert.equal(props.csg_products_with_failures, undefined);
    assert.equal(props.csg_silent_no_ops, undefined);
    assert.equal(props.csg_top_failure_reason, undefined);
  });
});
