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
