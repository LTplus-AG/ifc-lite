/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GeometryDiagnostics } from '@ifc-lite/geometry';
import { buildModelLoadedGeometryProps } from './modelLoadedGeometryProps.js';
import { stripSource } from '@/test/strip-comments.js';

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
      isResourceRetry: false,
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
        isResourceRetry: false,
      });
      assert.equal(props.total_csg_failures, undefined);
      assert.equal(props.csg_products_with_failures, undefined);
      assert.equal(props.csg_silent_no_ops, undefined);
      // The top reason belongs in THIS case, not only in "omits the top reason
      // when nothing failed" below — that one passes real diagnostics with a
      // zero count, which is a different input. Absent diagnostics had exactly
      // one home for this row (`cacheHitTelemetry.test.tsx:271`) until the
      // #2393 self-review counted them; a `?? 'None'` at the builder would
      // have been caught in one place only.
      assert.equal(props.csg_top_failure_reason, undefined);
    }
  });

  it('records a real zero as zero (a clean load is not an absent load)', () => {
    const props = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: 'lowest',
      skipSmallCuts: false,
      isResourceRetry: false,
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
      isResourceRetry: false,
    });
    assert.equal(fast.tessellation_tier, 'low');
    assert.equal(fast.skip_small_cuts, true);

    const exact = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: undefined,
      skipSmallCuts: false,
      isResourceRetry: false,
    });
    // `undefined` from resolveLoadTessellationTier IS the engine default, and it
    // must be reported as such — not as an absent field indistinguishable from
    // an older build that never sent one.
    assert.equal(exact.tessellation_tier, 'medium');
    assert.equal(exact.skip_small_cuts, false);
  });

  it('reports the resource-limit retry separately from the tier it retries at', () => {
    // `resolveResourceRetryTier` always retries at `lowest`, and a FIRST
    // attempt reaches `lowest` on its own (>= AUTO_LOWEST_TIER_MB in fast mode,
    // or a pinned `?geomTier=lowest`). Two loads at the SAME tier must still be
    // told apart, so the flag has to move independently of `tessellation_tier`.
    const retry = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: 'lowest',
      skipSmallCuts: true,
      isResourceRetry: true,
    });
    const firstAttempt = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: 'lowest',
      skipSmallCuts: true,
      isResourceRetry: false,
    });
    assert.equal(retry.tessellation_tier, firstAttempt.tessellation_tier);
    assert.equal(retry.is_resource_retry, true);
    // `false`, not absent: "this was a normal first attempt" is the statement
    // that makes the retry rows filterable at all.
    assert.equal(firstAttempt.is_resource_retry, false);
    assert.ok('is_resource_retry' in firstAttempt);
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
      isResourceRetry: false,
    });
    assert.equal(props.csg_top_failure_reason, 'OperandTooLarge');
  });

  it('omits the top reason when nothing failed', () => {
    const props = buildModelLoadedGeometryProps({
      diagnostics: diag(),
      tessellationTier: undefined,
      skipSmallCuts: true,
      isResourceRetry: false,
    });
    assert.equal(props.csg_top_failure_reason, undefined);
  });
});

/**
 * Read and stripped once. `code` has comments removed; `masked` is the same
 * text at the same offsets with string/template/regex bodies blanked. See
 * `@/test/strip-comments.ts` for why both views exist and why it is a
 * TypeScript parse rather than a lexical scan.
 */
const loaderPath = fileURLToPath(new URL('./useIfcLoader.ts', import.meta.url));
const loader = stripSource(readFileSync(loaderPath, 'utf8'), loaderPath);

/**
 * The argument list of ONE `captureModelLoaded(…)` call in `useIfcLoader.ts` —
 * a balanced-paren extraction, located by an `anchor` that must appear exactly
 * once inside it. The uniqueness assertion is part of the guard: an anchor that
 * starts matching a second site silently re-points the extraction at the wrong
 * call.
 *
 * Anchors in use:
 *  - `...buildModelLoadedPayload(` for the wasm path — unique in this file (the
 *    import line reads `buildModelLoadedPayload }`, with no following paren)
 *    and a call this PR does not touch, so it survives mutation of the
 *    `buildModelLoadedGeometryProps` wiring under test;
 *  - `load_path: 'server'` for the server fast path.
 *
 * Matching against one span only — rather than the whole file — means the
 * assertion can't be satisfied by an import line or by one of the other
 * `ifc_model_loaded` capture sites in this file that carry different fields.
 *
 * It does NOT make the check comment-proof on its own: a comment INSIDE the
 * span is inside the span, and the extraction happens after stripping for
 * exactly that reason. What the scoping buys is the *other* half — that a
 * match somewhere else in the module can't stand in for this call.
 *
 * The ANCHOR is looked up in `code` (comments gone, literals intact) because
 * one anchor IS a literal — `load_path: 'server'`. Everything after that runs
 * on `masked`, the same text with literal bodies blanked: the paren scan, so a
 * `(` inside a string cannot unbalance it, and the returned span, so prose in
 * a string literal cannot stand in for the call the assertions pin.
 *
 * Anchored on `captureModelLoaded(`, not `posthog.capture(`: `posthog.capture`
 * for this event is private to `loadTelemetry.ts` (#2624) — every call site
 * in this file, including the wasm path, goes through `captureModelLoaded`.
 */
function captureArgsAround(anchor: string): string {
  const { code, masked } = loader;
  const payloadSpreadIdx = code.indexOf(anchor);
  assert.notEqual(payloadSpreadIdx, -1, `${anchor} must appear somewhere in useIfcLoader.ts`);
  assert.equal(
    code.indexOf(anchor, payloadSpreadIdx + 1),
    -1,
    `${anchor} must be UNIQUE in useIfcLoader.ts, or this extraction is anchored on the wrong call`,
  );
  const callStart = code.lastIndexOf('captureModelLoaded(', payloadSpreadIdx);
  assert.notEqual(callStart, -1, `${anchor} must sit inside a captureModelLoaded(...) call`);
  const argsOpen = callStart + 'captureModelLoaded('.length - 1; // index of the call's own `(`
  assert.equal(masked[argsOpen], '(');
  let depth = 0;
  let argsClose = -1;
  for (let i = argsOpen; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) {
        argsClose = i;
        break;
      }
    }
  }
  assert.notEqual(argsClose, -1, 'the posthog.capture(...) call must have a matching close paren');
  return masked.slice(argsOpen + 1, argsClose);
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
  //
  // Read through the SAME helper as `captureArgsAround` above
  // (`@/test/strip-comments.ts`), and asserted against `masked`, not `code`.
  // Neither check is prose-proof by construction; both depend entirely on that
  // helper, which is why it is one module with its own unit tests rather than
  // per-test spellings. Every decoy below was demonstrated green against a
  // weaker version of it, with the real wiring deleted (#2393 review):
  //
  //  - RAW text: deleting the `loadDiagnostics = event.diagnostics` hoist while
  //    any comment in the module happens to mention it kept the whole-file
  //    `assert.match` green — with `loadDiagnostics` permanently null, which
  //    nulls every `csg_*` field this PR exists to make attributable;
  //  - a line-only stripper (`trimStart().startsWith('//')`): a TRAILING
  //    comment quoting the deleted `...buildModelLoadedGeometryProps({…})`
  //    spread kept all four argument-span assertions green;
  //  - a lexical scanner: a STRING literal quoting the deleted spread satisfied
  //    every assertion, because a string is not a comment;
  //  - the same scanner: a regex literal with an unbalanced quote (`/['"]/g`)
  //    desynchronised its string tracker, so the `//` comment after it was not
  //    stripped and a plainly commented-out call passed — in this check and in
  //    the argument-span one.
  //
  // The last two are why the helper is now a TypeScript parse. This module has
  // 13 block comments, one nine lines below the protected declaration.
  const src = loader.masked;

  it('spreads the builder, wired to the load diagnostics and fidelity inputs, into the wasm-path ifc_model_loaded capture', () => {
    const args = captureArgsAround('...buildModelLoadedPayload(');
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

  it('marks the SERVER fast path\'s capture as a retry when it is one', () => {
    // The third capture site (#2393 self-review). It is reachable on a retry:
    // a first attempt falls through to WASM because the server is momentarily
    // down, OOMs, and `tryResourceRetry` re-enters `loadFile` — by which time
    // the server may be back, producing a `load_path: 'server'` row that is
    // indistinguishable from a normal load without this flag.
    const args = captureArgsAround("load_path: 'server'");
    assert.ok(
      args.includes('is_resource_retry: isResourceRetryLoad'),
      "the server-path ifc_model_loaded capture must carry is_resource_retry — the retry can land on this path, and every other capture site states it",
    );
    // And ONLY that. `tessellation_tier` / `skip_small_cuts` describe LOCAL
    // WASM tessellation; the server produces canonical full-fidelity geometry
    // under its own cache key and applies neither, so reporting them here
    // would fabricate an attribution — the failure mode #2388 exists to
    // prevent. Absent must stay absent on this path.
    assert.ok(
      !args.includes('buildModelLoadedGeometryProps'),
      'the server path must NOT report local tessellation inputs it never applied',
    );
  });
});

/*
 * The cache-hit half of #2388 is tested where it can be OBSERVED, not here:
 * `useIfcLoader.cacheHitTelemetry.test.tsx` seeds a real cache entry, drives
 * the real `loadFile` to a real hit, and reads the `ifc_model_loaded` payload
 * that actually leaves `posthog.capture`. That path is reachable under
 * `tsx --test` — the hit is decided at `loadStage = 'cache-lookup'`, hundreds
 * of lines before the wasm engine is touched — so it needs no source-text
 * stand-in and no builder-level stand-in either, unlike the wasm-path wiring
 * above.
 *
 * A builder-level "mirrors the call shape the cache-hit site should use" test
 * lived here until #2393 review, and was removed rather than kept as a second
 * spelling of the same claim. The commit that removed it said every assertion
 * it made was "covered twice over". That was not accurate — counted row by
 * row in the #2393 self-review, five of its seven had two surviving homes and
 * two had one. Where the missing home was worth having, it was ADDED rather
 * than argued away:
 *
 *  - absent CSG counters (`total_csg_failures`, `csg_products_with_failures`,
 *    `csg_silent_no_ops`) for absent diagnostics — the builder unit test
 *    "leaves the CSG counts UNSET when no producer emitted diagnostics"
 *    above, and behaviourally `cacheHitTelemetry.test.tsx`'s "leaves the CSG
 *    counters ABSENT on a cache hit" (mutation-verified: flattening any of
 *    them to `?? 0` fails it). Two homes.
 *  - absent `csg_top_failure_reason` for ABSENT diagnostics — had exactly one
 *    home (`cacheHitTelemetry.test.tsx:271`). "Omits the top reason when
 *    nothing failed" above is a DIFFERENT input: real diagnostics with a zero
 *    count. The absent-diagnostics assertion is now part of "leaves the CSG
 *    counts UNSET …" too, so this row has two homes as well.
 *  - `tessellation_tier` / `skip_small_cuts` carrying real values — the
 *    builder unit test "records the two fidelity inputs …" above, and
 *    behaviourally the cache-hit test's two OPPOSITE-fidelity loads, which
 *    also rule out the hardcoded constant a single-value mirror cannot. Two
 *    homes.
 *  - the COMBINED case — CSG counters absent while the fidelity fields still
 *    carry real values, i.e. "absent CSG was not achieved by dropping the
 *    whole geometry-props spread" — still has exactly ONE home,
 *    `cacheHitTelemetry.test.tsx:280-282`, and deliberately so: the only
 *    second spelling available at the builder level is the mirrored call that
 *    was deleted, which asserts what the test file says rather than what the
 *    capture site does. One behavioural home beats two, one of them fictional.
 *
 * That single home is load-bearing, so it is worth stating why it cannot go
 * quiet: `captureCacheHitPayload` asserts it saw exactly one
 * `load_path === 'cache'` event and says in the failure message that a count
 * of 0 would prove nothing. A fixture that stopped reaching the cache-hit
 * branch fails loudly rather than passing vacuously — verified.
 */
