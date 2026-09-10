/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { initWasmWithRetry, isTransientWasmLoadError } from './wasm-init-retry.js';

const noop = () => {};
const instantSleep = () => Promise.resolve();

describe('isTransientWasmLoadError', () => {
  it('flags the wasm-bindgen non-OK HTTP status (PostHog issue 019ed949)', () => {
    expect(
      isTransientWasmLoadError(
        "Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok",
      ),
    ).toBe(true);
  });

  it('flags transport/network failures (cross-browser)', () => {
    expect(isTransientWasmLoadError('Failed to fetch')).toBe(true); // Chromium
    expect(isTransientWasmLoadError('NetworkError when attempting to fetch resource')).toBe(true); // Firefox
    expect(isTransientWasmLoadError('Load failed')).toBe(true); // Safari
  });

  it('does NOT flag genuine compile/validation errors (bad bytes never recover on retry)', () => {
    expect(isTransientWasmLoadError('CompileError: invalid value type')).toBe(false);
    expect(
      isTransientWasmLoadError(
        'CompileError: WebAssembly.instantiateStreaming(): expected magic word 00 61 73 6d',
      ),
    ).toBe(false);
    expect(isTransientWasmLoadError('wasm validation error: at offset 0')).toBe(false);
    expect(isTransientWasmLoadError('unreachable executed')).toBe(false);
  });
});

describe('initWasmWithRetry', () => {
  it('returns after a single successful init (no retry)', async () => {
    const init = vi.fn().mockResolvedValue(undefined);
    await initWasmWithRetry(init, { sleep: instantSleep, warn: noop });
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('retries once on a transient error and succeeds', async () => {
    const init = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok"),
      )
      .mockResolvedValueOnce(undefined);
    await initWasmWithRetry(init, { sleep: instantSleep, warn: noop });
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-transient error and rethrows immediately', async () => {
    const init = vi.fn().mockRejectedValue(new Error('CompileError: invalid value type'));
    await expect(initWasmWithRetry(init, { sleep: instantSleep, warn: noop })).rejects.toThrow(
      /CompileError/,
    );
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('propagates the second failure after retrying a transient error', async () => {
    const init = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    await expect(initWasmWithRetry(init, { sleep: instantSleep, warn: noop })).rejects.toThrow(
      /Failed to fetch/,
    );
    expect(init).toHaveBeenCalledTimes(2);
  });

  // Issue #1903: WebKit rejects a failed fetch with `TypeError: Load failed` and
  // an EMPTY stack, so a bare rethrow reaches error tracking naming nothing.
  it('names the engine binary when the final failure identifies nothing (#1903)', async () => {
    const original = new TypeError('Load failed'); // Safari
    const init = vi.fn().mockRejectedValue(original);
    await expect(
      initWasmWithRetry(init, { sleep: instantSleep, warn: noop, label: 'ifc-lite-bridge' }),
    ).rejects.toThrow(/Failed to load the WASM engine binary \(ifc-lite_bg\.wasm\) in ifc-lite-bridge: Load failed/);
    expect(init).toHaveBeenCalledTimes(2);
    // The original is preserved for programmatic inspection, never swallowed.
    await initWasmWithRetry(init, { sleep: instantSleep, warn: noop }).catch((err) => {
      expect((err as Error).cause).toBe(original);
    });
  });

  it('names the engine binary for the Chromium wording too', async () => {
    const init = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      initWasmWithRetry(init, { sleep: instantSleep, warn: noop, label: 'geometry.worker' }),
    ).rejects.toThrow(/ifc-lite_bg\.wasm.*geometry\.worker.*Failed to fetch/);
  });

  // The #1363 stale-deploy matchers key on the browser's EXACT wasm phrasing;
  // rewriting a message that already identifies itself would break them.
  it('leaves a self-identifying wasm message byte-for-byte intact (#1363 skew recovery)', async () => {
    const mime =
      "WebAssembly: Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'";
    const status = "Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok";
    // #1903: assert the RETRY COUNT too. Preserving the message passes either
    // way, so without these counts a regression that stopped retrying the
    // transient `status` error would sail through this case unnoticed.
    // `mime` is not transient (no transport phrase) so it never even retries;
    // `status` is, and must survive the retry unchanged.
    for (const [message, expectedCalls] of [
      [mime, 1],
      [status, 2],
    ] as const) {
      const init = vi.fn().mockRejectedValue(new TypeError(message));
      const err = await initWasmWithRetry(init, { sleep: instantSleep, warn: noop })
        .then(() => null, (e: Error) => e);
      expect(err?.message).toBe(message);
      expect(init).toHaveBeenCalledTimes(expectedCalls);
    }
  });

  // A failed module load already carries its own specifier. Prefixing it with
  // `ifc-lite_bg.wasm` would make `isWasmAssetUnavailableError` read it as a
  // rotated ENGINE BINARY and reload the page for an unrelated chunk.
  it('does not rewrite a failed dynamic module import into a wasm-asset signature', async () => {
    const message = 'Failed to fetch dynamically imported module: https://example.test/assets/chunk.js';
    const init = vi.fn().mockRejectedValue(new TypeError(message));
    const err = await initWasmWithRetry(init, { sleep: instantSleep, warn: noop })
      .then(() => null, (e: Error) => e);
    expect(err?.message).toBe(message);
    expect(err?.message).not.toMatch(/\.wasm/);
  });

  // The attribution must never re-type a throwable the bridge discriminates on
  // (`error instanceof WebAssembly.RuntimeError` marks the fatal, unrecoverable
  // panic state).
  it('preserves the throwable identity of a non-transient second failure (#1903)', async () => {
    // Assert the EXACT instance, not just the class: `toBeInstanceOf` would
    // also accept a freshly constructed RuntimeError, which is precisely the
    // re-typing this case exists to forbid.
    const runtimeError = new WebAssembly.RuntimeError('unreachable');
    const init = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockRejectedValueOnce(runtimeError);
    await expect(
      initWasmWithRetry(init, { sleep: instantSleep, warn: noop }),
    ).rejects.toBe(runtimeError);
  });

  it('waits the configured delay before retrying', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const init = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(undefined);
    await initWasmWithRetry(init, { sleep, warn: noop, retryDelayMs: 500 });
    expect(sleep).toHaveBeenCalledWith(500);
  });
});
