/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import * as lifecycle from '@ifc-lite/wasm-lifecycle';
import { initWasmWithRetry, isTransientWasmLoadError } from './wasm-init-retry.js';

// #4247: detailed retry/classification cases live in wasm-lifecycle. These
// checks keep this consumer path bound to that tested implementation.
describe('WASM retry forwarding', () => {
  it('exports the canonical retry and classification functions', () => {
    expect(initWasmWithRetry).toBe(lifecycle.initWasmWithRetry);
    expect(isTransientWasmLoadError).toBe(lifecycle.isTransientWasmLoadError);
  });

  it('forwards retry options and completes after a transient failure', async () => {
    const init = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    await initWasmWithRetry(init, { sleep, warn, retryDelayMs: 17, label: 'parser' });

    expect(init).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(17);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[parser] WASM engine load failed (Failed to fetch); retrying once',
    );
  });

  it('propagates the exact terminal failure instead of swallowing or wrapping it', async () => {
    const failure = new WebAssembly.RuntimeError('unreachable');
    const init = vi.fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockRejectedValueOnce(failure);

    await expect(initWasmWithRetry(init, {
      sleep: () => Promise.resolve(),
      warn: () => {},
    })).rejects.toBe(failure);
    expect(init).toHaveBeenCalledTimes(2);
  });
});
