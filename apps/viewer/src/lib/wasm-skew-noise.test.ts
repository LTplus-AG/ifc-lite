/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSuppressWasmSkewNoise,
  type SkewNoiseDeps,
} from './wasm-version-skew.js';

// A controllable clock + in-memory store so the decaying-counter logic is
// deterministic (no real sessionStorage / Date).
function harness(startMs = 1_000_000): {
  deps: SkewNoiseDeps;
  advance: (ms: number) => void;
  store: Map<string, string>;
  setReloaded: (v: boolean) => void;
} {
  let t = startMs;
  let reloaded = false;
  const store = new Map<string, string>();
  return {
    store,
    advance: (ms) => { t += ms; },
    setReloaded: (v) => { reloaded = v; },
    deps: {
      now: () => t,
      read: (k) => (store.has(k) ? store.get(k)! : null),
      write: (k, v) => { store.set(k, v); },
      hasRecentReload: () => reloaded,
    },
  };
}

const skewEvent = (value: string) => ({
  event: '$exception',
  properties: { $exception_list: [{ type: 'TypeError', value }] },
});

// The two signatures that are actually active in PostHog.
const MIME_SKEW =
  "WebAssembly: Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'";
const HTTP_SKEW =
  "Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok";

describe('shouldSuppressWasmSkewNoise', () => {
  it('surfaces the FIRST post-reload recurrence — the stuck-deploy case', () => {
    // The scenario that matters: a stale tab hits skew (suppressed, we reload),
    // and after the reload the wasm is STILL unreachable (CSP / proxy). The user
    // typically hits this once and gives up, so if we spent a counting budget on
    // it error tracking would never learn the deploy is broken.
    const h = harness();
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), true);  // pre-reload
    h.setReloaded(true);
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), false); // post-reload → surfaces
  });

  it('caps a pre-reload flood (several workers throwing in the same tick)', () => {
    const h = harness();
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), true);  // 1
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), true);  // 2
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), true);  // 3
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), false); // capped
  });

  it('matches both active skew signatures (MIME and HTTP-status)', () => {
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), harness().deps), true);
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(HTTP_SKEW), harness().deps), true);
  });

  it('never suppresses a non-skew exception', () => {
    const h = harness();
    assert.equal(
      shouldSuppressWasmSkewNoise(skewEvent("Cannot read properties of undefined (reading 'x')"), h.deps),
      false,
    );
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent('Geometry stream stalled after 40000ms.'), h.deps), false);
    // A genuine wasm CORRUPTION (CompileError) is not skew — must surface.
    assert.equal(
      shouldSuppressWasmSkewNoise(skewEvent('CompileError: WebAssembly.instantiate(): invalid magic word'), h.deps),
      false,
    );
  });

  it('never suppresses a non-$exception event', () => {
    const h = harness();
    assert.equal(shouldSuppressWasmSkewNoise({ event: '$pageview', properties: {} }, h.deps), false);
    assert.equal(shouldSuppressWasmSkewNoise(null, h.deps), false);
    assert.equal(
      shouldSuppressWasmSkewNoise({ event: 'ifc_model_loaded', properties: { file_size_mb: 12 } }, h.deps),
      false,
    );
  });

  it('gives a genuinely-later skew a fresh suppression budget (decay)', () => {
    const h = harness();
    // Exhaust the budget on a first skew episode.
    for (let i = 0; i < 5; i++) shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps);
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), false);
    // A second deploy skews the tab again 6 minutes later — judged on its own
    // recurrence, so it is suppressed afresh rather than treated as a block.
    h.advance(6 * 60_000);
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), h.deps), true);
  });

  it('does not decay within the window — a rapid persistent block still surfaces', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      assert.equal(shouldSuppressWasmSkewNoise(skewEvent(HTTP_SKEW), h.deps), true);
      h.advance(2_000); // still well inside the 5-min window
    }
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(HTTP_SKEW), h.deps), false);
  });

  it('reads the message from $exception_values when $exception_list is absent', () => {
    const h = harness();
    const out = shouldSuppressWasmSkewNoise(
      { event: '$exception', properties: { $exception_values: [MIME_SKEW] } },
      h.deps,
    );
    assert.equal(out, true);
  });

  it('does NOT suppress when only the TIMESTAMP fails to persist', () => {
    // Partial persistence is the subtler runaway: with no durable `lastTs`,
    // every later call sees the episode as decayed, resets the count to 1, and
    // would suppress forever — reaching the same failure through the decay
    // branch rather than the counter. Both read-backs must confirm.
    const store = new Map<string, string>();
    const countOnly: SkewNoiseDeps = {
      now: () => 1,
      read: (k) => (store.has(k) ? store.get(k)! : null),
      // Drop timestamp writes only; the count persists fine.
      write: (k, v) => { if (!k.endsWith('-ts')) store.set(k, v); },
      hasRecentReload: () => false,
    };
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), countOnly), false);
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), countOnly), false);
  });

  it('does NOT suppress when storage is unavailable (cannot bound the count)', () => {
    // Blocked storage: writes are dropped and reads return null, so the count
    // could never advance past 1 and suppression would run forever — hiding a
    // genuine persistent block. The read-back check must defeat that: with no
    // durable count we surface the exception every time.
    const blocked: SkewNoiseDeps = {
      now: () => 1, read: () => null, write: () => {}, hasRecentReload: () => false,
    };
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), blocked), false);
    assert.equal(shouldSuppressWasmSkewNoise(skewEvent(MIME_SKEW), blocked), false);
  });
});
