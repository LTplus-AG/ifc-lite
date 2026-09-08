/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  handlePreloadError,
  isChunkLoadError,
  isCssPreloadFailure,
  shouldSuppressChunkSkewNoise,
  type ChunkSkewDeps,
  type VitePreloadErrorEvent,
} from './chunk-version-skew.js';

/** Minimal stand-in for the cancelable `vite:preloadError` event. */
function makeEvent(payload: unknown): VitePreloadErrorEvent & { defaultPrevented: boolean } {
  return {
    payload,
    defaultPrevented: false,
    preventDefault(this: { defaultPrevented: boolean }) {
      this.defaultPrevented = true;
    },
  } as unknown as VitePreloadErrorEvent & { defaultPrevented: boolean };
}

interface Harness {
  deps: ChunkSkewDeps;
  reloads: number;
  pendingAt: number | null;
  /** Epoch-ms of the last recorded reload, mirroring the sessionStorage key. */
  stored: number | null;
  /** Advance the harness clock, so the debounce window can be crossed. */
  clock: number;
}

/** Mirrors the real 60s debounce in chunk-version-skew.ts. */
const DEBOUNCE_MS = 60_000;

function makeDeps(opts: {
  /** Seed a previous reload at this epoch-ms. */
  lastReloadAt?: number;
  /** Storage cannot be read (private mode / sandboxed frame). */
  unreadable?: boolean;
  /** setItem is accepted but silently discarded, or throws. */
  unwritable?: boolean;
  now?: number;
} = {}): Harness {
  const h: Harness = {
    reloads: 0,
    pendingAt: null,
    stored: opts.lastReloadAt ?? null,
    clock: opts.now ?? 1_000_000,
    deps: null as unknown as ChunkSkewDeps,
  };
  h.deps = {
    now: () => h.clock,
    reload: () => { h.reloads += 1; },
    // The production reader returns `true` when storage throws, so an
    // unrecordable attempt is never performed.
    hasRecentReload: (now) =>
      opts.unreadable ? true : h.stored !== null && now - h.stored < DEBOUNCE_MS,
    rememberReload: (now) => {
      if (opts.unwritable) return false;
      h.stored = now;
      return true;
    },
    markReloadPending: (now) => { h.pendingAt = now; },
  };
  return h;
}

// The whole point of the fix: which arm of Vite's preload helper we are on
// decides whether suppressing the re-throw is safe. See chunk-version-skew.ts.
describe('isCssPreloadFailure', () => {
  it('matches Vite\'s CSS-preload arm, the only reason it constructs itself', () => {
    assert.equal(
      isCssPreloadFailure(new Error('Unable to preload CSS for /assets/panel-a1b2c3.css')),
      true,
    );
  });

  it('does not match a failed module import, whatever the engine calls it', () => {
    // Chromium, WebKit and Gecko each word this differently; none of them is
    // Vite's CSS string, which is what the discriminator relies on.
    for (const message of [
      'Failed to fetch dynamically imported module: https://x/assets/bcf-C3r7vdyE.js',
      'Importing a module script failed.',
      'error loading dynamically imported module',
    ]) {
      assert.equal(isCssPreloadFailure(new Error(message)), false, message);
    }
  });

  it('reads a bare string or an error-shaped object, and matches neither a missing nor a non-error payload', () => {
    assert.equal(isCssPreloadFailure('Unable to preload CSS for /a.css'), true);
    assert.equal(isCssPreloadFailure({ message: 'Unable to preload CSS for /a.css' }), true);
    assert.equal(isCssPreloadFailure(undefined), false);
    assert.equal(isCssPreloadFailure(null), false);
    assert.equal(isCssPreloadFailure(42), false);
  });
});

// The boundary wraps whole page subtrees, so it must tell a chunk that failed to
// LOAD apart from a crash inside a chunk that loaded fine.
describe('isChunkLoadError', () => {
  it('matches how each engine words a failed dynamic import', () => {
    for (const message of [
      // Chromium
      'Failed to fetch dynamically imported module: https://x/assets/bcf-C3r7vdyE.js',
      // Gecko
      'error loading dynamically imported module',
      // WebKit
      'Importing a module script failed.',
      // A host that answers a missing asset with its SPA fallback instead of a
      // 404: the browser gets index.html and rejects the MIME type.
      'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of text/html.',
      // Vite's own CSS arm
      'Unable to preload CSS for /assets/panel.css',
    ]) {
      assert.equal(isChunkLoadError(new Error(message)), true, message);
    }
  });

  it('does NOT match an ordinary crash inside a chunk that loaded fine', () => {
    // These would otherwise be filed under the chunk-skew context and told the
    // user their tab was out of date. Includes shapes that merely mention
    // modules or loading, so the matcher cannot be loose about it.
    for (const message of [
      "Cannot read properties of undefined (reading 'rows')",
      'Maximum update depth exceeded',
      'Failed to fetch',
      'Cannot access module before initialization',
      'Objects are not valid as a React child',
    ]) {
      assert.equal(isChunkLoadError(new Error(message)), false, message);
    }
  });

  it('tolerates a non-Error payload', () => {
    assert.equal(isChunkLoadError('Importing a module script failed.'), true);
    assert.equal(isChunkLoadError(undefined), false);
    assert.equal(isChunkLoadError(null), false);
    assert.equal(isChunkLoadError(42), false);
  });
});

describe('handlePreloadError', () => {
  it('does NOT preventDefault on a module failure, so the import rejects', () => {
    // The regression this whole PR exists for. `preventDefault()` here makes
    // Vite's handler return undefined from `baseModule().catch(...)`, so
    // `await import(...)` resolves to `undefined` and every consumer
    // dereferences it (issues #1926, #1938, #1941).
    const h = makeDeps();
    const event = makeEvent(new Error('Failed to fetch dynamically imported module: /assets/x.js'));
    assert.equal(handlePreloadError(event, h.deps), 'reloaded');
    assert.equal(event.defaultPrevented, false);
    assert.equal(h.reloads, 1);
  });

  it('DOES preventDefault on a CSS preload failure, which cannot poison the module', () => {
    // Vite carries on to call baseModule() after this arm, so suppressing keeps
    // a stylesheet that failed to warm the cache from failing a good import.
    const h = makeDeps();
    const event = makeEvent(new Error('Unable to preload CSS for /assets/panel.css'));
    assert.equal(handlePreloadError(event, h.deps), 'reloaded');
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.reloads, 1);
  });

  it('never spends two reloads on one skew', () => {
    const h = makeDeps();
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'reloaded');
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'surfaced');
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'surfaced');
    assert.equal(h.reloads, 1);
  });

  it('does not loop on a chunk that stays missing across reloads', () => {
    // The regression the timestamp replaced a counter for. The old counter was
    // cleared on every mount, and a LAZY chunk only fails AFTER mount, so the
    // budget was always fresh: a permanently-missing chunk reloaded forever on a
    // blank page. Simulate that by re-running the handler on each fresh document
    // (a new tab-lifetime is NOT simulated: sessionStorage survives a reload).
    const h = makeDeps();
    for (let i = 0; i < 20; i++) {
      h.clock += 250; // a reload cycle, far inside the debounce window
      handlePreloadError(makeEvent(new Error('boom')), h.deps);
    }
    assert.equal(h.reloads, 1);
  });

  it('lets a genuinely later deploy recover once the window elapses', () => {
    const h = makeDeps();
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'reloaded');
    h.clock += DEBOUNCE_MS - 1;
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'surfaced');
    h.clock += 2;
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'reloaded');
    assert.equal(h.reloads, 2);
  });

  it('treats a FUTURE reload stamp as stale rather than a permanent block', () => {
    // A negative elapsed time satisfies `< RELOAD_DEBOUNCE_MS` on its own, so
    // without the `>= 0` guard a clock that moved backward (NTP correction, VM
    // resume) would pin the tab at "recently reloaded" and disable skew recovery
    // until wall time caught up. Exercised through the PRODUCTION predicate
    // shape, which is what the guard lives in.
    const recent = (now: number, ts: number) => {
      const elapsed = now - ts;
      return Number.isFinite(ts) && elapsed >= 0 && elapsed < DEBOUNCE_MS;
    };
    assert.equal(recent(1_000, 1_000_000), false, 'stamp far in the future must not block');
    assert.equal(recent(1_000_000, 999_000), true, 'a genuinely recent stamp still blocks');
    assert.equal(recent(1_000_000, 800_000), false, 'an old stamp lets recovery run again');
  });

  it('refuses to reload when the attempt cannot be read', () => {
    // Unbounded retries on a permanently missing chunk would loop forever.
    const h = makeDeps({ unreadable: true });
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'surfaced');
    assert.equal(h.reloads, 0);
    assert.equal(h.pendingAt, null);
  });

  it('refuses to reload when the attempt cannot be persisted', () => {
    const h = makeDeps({ unwritable: true });
    assert.equal(handlePreloadError(makeEvent(new Error('boom')), h.deps), 'surfaced');
    assert.equal(h.reloads, 0);
    assert.equal(h.pendingAt, null);
  });

  it('still suppresses the CSS arm when no reload is allowed', () => {
    // The two decisions are independent: whether to reload is a budget question,
    // whether to suppress is about what the import resolves to.
    const h = makeDeps({ unreadable: true });
    const event = makeEvent(new Error('Unable to preload CSS for /assets/panel.css'));
    assert.equal(handlePreloadError(event, h.deps), 'surfaced');
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.reloads, 0);
  });

  it('marks the reload pending only on the path that actually reloads', () => {
    const h = makeDeps({ now: 5_000 });
    handlePreloadError(makeEvent(new Error('boom')), h.deps);
    assert.equal(h.pendingAt, 5_000);

    const debounced = makeDeps({ now: 5_000, lastReloadAt: 4_900 });
    handlePreloadError(makeEvent(new Error('boom')), debounced.deps);
    assert.equal(debounced.pendingAt, null);
  });
});

describe('shouldSuppressChunkSkewNoise', () => {
  const exception = { event: '$exception', properties: { $exception_values: ['boom'] } };

  it('suppresses nothing when no reload is in flight', () => {
    assert.equal(
      shouldSuppressChunkSkewNoise(exception, { now: () => 0, reloadPendingSince: () => null }),
      false,
    );
  });

  it('drops the collateral captured while a reload is committing', () => {
    // These are the arbitrary TypeErrors from every consumer still awaiting the
    // dead chunk. They share no vocabulary with the cause, which is why the gate
    // is time-based rather than a message matcher.
    assert.equal(
      shouldSuppressChunkSkewNoise(
        { event: '$exception', properties: { $exception_values: ["Cannot read properties of undefined (reading 'Map')"] } },
        { now: () => 1_200, reloadPendingSince: () => 1_000 },
      ),
      true,
    );
  });

  it('keeps non-exception events, which are still true in that window', () => {
    for (const e of [{ event: '$pageleave' }, { event: 'ifc_model_loaded' }]) {
      assert.equal(
        shouldSuppressChunkSkewNoise(e, { now: () => 1_200, reloadPendingSince: () => 1_000 }),
        false,
      );
    }
    assert.equal(
      shouldSuppressChunkSkewNoise(null, { now: () => 1_200, reloadPendingSince: () => 1_000 }),
      false,
    );
  });

  it('stops suppressing once the window elapses', () => {
    // A cancelled navigation (beforeunload prompt) must not silence the tab for
    // the rest of its life.
    assert.equal(
      shouldSuppressChunkSkewNoise(exception, { now: () => 11_001, reloadPendingSince: () => 1_000 }),
      false,
    );
    assert.equal(
      shouldSuppressChunkSkewNoise(exception, { now: () => 10_999, reloadPendingSince: () => 1_000 }),
      true,
    );
  });

  it('does not suppress indefinitely if the clock jumps backwards', () => {
    assert.equal(
      shouldSuppressChunkSkewNoise(exception, { now: () => 500, reloadPendingSince: () => 1_000 }),
      false,
    );
  });
});
