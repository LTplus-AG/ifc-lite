/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverFromWasmVersionSkew,
  recoverFromWorkerScriptSkew,
  installWasmVersionSkewRecovery,
  __resetWasmVersionSkewForTests,
  type VersionSkewDeps,
} from './wasm-version-skew.js';

const MIME_SKEW =
  "WebAssembly: Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'";

/** A controllable clock + in-memory reload bookkeeping for the recovery deps. */
class Harness {
  reloads = 0;
  /** Simulates sessionStorage being blocked (private mode / sandboxed embed). */
  storageBlocked = false;
  private now: number;
  private lastReloadAt: number | null = null;
  readonly deps: VersionSkewDeps;

  constructor(initialNow = 1_000_000) {
    this.now = initialNow;
    this.deps = {
      now: () => this.now,
      reload: () => {
        this.reloads += 1;
      },
      hasRecentReload: (n) => this.lastReloadAt != null && n - this.lastReloadAt < 60_000,
      rememberReload: (n) => {
        if (this.storageBlocked) return false;
        this.lastReloadAt = n;
        return true;
      },
    };
  }

  setNow(n: number): void {
    this.now = n;
  }
}

function makeDeps(initialNow = 1_000_000): Harness {
  return new Harness(initialNow);
}

describe('recoverFromWasmVersionSkew', () => {
  it('reloads once on a stale-deploy WASM MIME error (issue #1363)', () => {
    const h = makeDeps();
    assert.equal(recoverFromWasmVersionSkew(MIME_SKEW, h.deps), true);
    assert.equal(h.reloads, 1);
  });

  it('does NOT reload for an unrelated error', () => {
    const h = makeDeps();
    assert.equal(recoverFromWasmVersionSkew('RangeError: invalid array length', h.deps), false);
    assert.equal(h.reloads, 0);
  });

  it('debounces a second skew within the window (no reload loop)', () => {
    const h = makeDeps(1_000_000);
    assert.equal(recoverFromWasmVersionSkew(MIME_SKEW, h.deps), true);
    h.setNow(1_030_000); // +30s, still inside the 60s window
    assert.equal(recoverFromWasmVersionSkew(MIME_SKEW, h.deps), false);
    assert.equal(h.reloads, 1);
  });

  it('recovers again after the debounce window elapses (later redeploy)', () => {
    const h = makeDeps(1_000_000);
    assert.equal(recoverFromWasmVersionSkew(MIME_SKEW, h.deps), true);
    h.setNow(1_000_000 + 61_000); // past the window
    assert.equal(recoverFromWasmVersionSkew(MIME_SKEW, h.deps), true);
    assert.equal(h.reloads, 2);
  });

  it('accepts an Error object, not just a string', () => {
    const h = makeDeps();
    assert.equal(recoverFromWasmVersionSkew(new TypeError(MIME_SKEW), h.deps), true);
    assert.equal(h.reloads, 1);
  });
});

describe('recoverFromWorkerScriptSkew (pre-classified by the geometry library)', () => {
  it('reloads once without re-running the message matcher', () => {
    // The worker-script 404 signature has NO message (the MIME detail goes
    // only to the console), so the strict matcher can never accept it; the
    // library's classification must be trusted (adversarial finding on #1680).
    const h = makeDeps();
    assert.equal(recoverFromWorkerScriptSkew(h.deps), true);
    assert.equal(h.reloads, 1);
  });

  it('debounces a second worker-script skew within the window', () => {
    const h = makeDeps(1_000_000);
    assert.equal(recoverFromWorkerScriptSkew(h.deps), true);
    h.setNow(1_030_000);
    assert.equal(recoverFromWorkerScriptSkew(h.deps), false);
    assert.equal(h.reloads, 1);
  });

  it('REFUSES to reload when the attempt cannot be recorded (storage blocked)', () => {
    // A permanent condition (CSP-blocked worker spawn, proxy rewriting
    // assets) in a storage-partitioned embed would otherwise reload on every
    // occurrence with no debounce at all - a reload loop.
    const h = makeDeps();
    h.storageBlocked = true;
    assert.equal(recoverFromWorkerScriptSkew(h.deps), false);
    assert.equal(h.reloads, 0);
  });
});

describe('storage-veto applies to the message-matched path too', () => {
  it('does not reload a matching wasm-MIME error when the attempt cannot be recorded', () => {
    const h = makeDeps();
    h.storageBlocked = true;
    assert.equal(recoverFromWasmVersionSkew(MIME_SKEW, h.deps), false);
    assert.equal(h.reloads, 0);
  });
});

describe('installWasmVersionSkewRecovery', () => {
  it('is a safe no-op without a DOM window', () => {
    __resetWasmVersionSkewForTests();
    // No `window` in the node:test runtime — must not throw.
    assert.doesNotThrow(() => installWasmVersionSkewRecovery());
  });
});
