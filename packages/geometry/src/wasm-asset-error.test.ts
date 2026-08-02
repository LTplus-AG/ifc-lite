/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isWasmAssetUnavailableError,
  notifyIfWorkerScriptUnavailable,
  notifyIfWasmAssetUnavailable,
  WASM_ASSET_UNAVAILABLE_EVENT,
} from './wasm-asset-error.js';

describe('isWasmAssetUnavailableError', () => {
  it('flags the Firefox wrong-MIME engine binary (PostHog issue #1363)', () => {
    // The exact message captured: a rotated hashed wasm 404s as text/plain.
    expect(
      isWasmAssetUnavailableError(
        "WebAssembly: Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'",
      ),
    ).toBe(true);
  });

  it('flags the Chromium wrong-MIME phrasing', () => {
    expect(
      isWasmAssetUnavailableError("Incorrect response MIME type. Expected 'application/wasm'."),
    ).toBe(true);
  });

  it('flags a non-OK HTTP status on a WebAssembly compile (asset gone)', () => {
    expect(
      isWasmAssetUnavailableError(
        "Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok",
      ),
    ).toBe(true);
    expect(
      isWasmAssetUnavailableError('WebAssembly compile failed: status 404'),
    ).toBe(true);
  });

  it('flags a dynamic-import of a now-missing .wasm chunk', () => {
    expect(
      isWasmAssetUnavailableError(
        'Failed to fetch dynamically imported module: https://app/assets/ifc-lite_bg-OLD.wasm',
      ),
    ).toBe(true);
  });

  it('sees through the worker-pool wrapper prefix', () => {
    expect(
      isWasmAssetUnavailableError(
        "Geometry worker error: WebAssembly: Response has unsupported MIME type 'text/plain' expected 'application/wasm'",
      ),
    ).toBe(true);
  });

  it('accepts Error objects, not just strings', () => {
    expect(
      isWasmAssetUnavailableError(
        new TypeError("Response has unsupported MIME type 'text/plain' expected 'application/wasm'"),
      ),
    ).toBe(true);
  });

  it('does NOT flag a genuine corrupt-module compile error (reload would loop)', () => {
    expect(
      isWasmAssetUnavailableError(
        'CompileError: expected magic word 00 61 73 6d, found 3c 21 44 4f',
      ),
    ).toBe(false);
  });

  it('does NOT flag unrelated errors', () => {
    expect(isWasmAssetUnavailableError('RangeError: invalid array length')).toBe(false);
    expect(isWasmAssetUnavailableError('Geometry worker error: unreachable')).toBe(false);
    expect(isWasmAssetUnavailableError('')).toBe(false);
    expect(isWasmAssetUnavailableError(null)).toBe(false);
    expect(isWasmAssetUnavailableError(undefined)).toBe(false);
  });
});

describe('notifyIfWasmAssetUnavailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches the event on a version-skew error and returns true', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    // CustomEvent exists in the test (jsdom/happy-dom or Node ≥ 19) — assert it
    // is used. If the runtime lacks it, the function still returns true.
    const matched = notifyIfWasmAssetUnavailable(
      "Response has unsupported MIME type 'text/plain' expected 'application/wasm'",
    );
    expect(matched).toBe(true);
    if (typeof CustomEvent === 'function') {
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe(WASM_ASSET_UNAVAILABLE_EVENT);
    }
  });

  it('does not dispatch (and returns false) for an unrelated error', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    expect(notifyIfWasmAssetUnavailable('some unrelated failure')).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

describe('notifyIfWorkerScriptUnavailable', () => {
  it('treats an empty-message error from a worker that never spoke as version skew', () => {
    // The stale-deploy signature: the worker SCRIPT 404s (served text/plain),
    // the browser blocks it and fires onerror with NO message - the MIME
    // detail goes only to the console.
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    expect(notifyIfWorkerScriptUnavailable({ message: undefined }, false)).toBe(true);
    if (typeof CustomEvent === 'function') {
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe(WASM_ASSET_UNAVAILABLE_EVENT);
      expect(String(event.detail.message)).toMatch(/worker script/i);
    }
  });

  it('does NOT fire for an empty-message error after the worker already spoke', () => {
    // A hard in-worker crash (e.g. the wasm thread aborting under memory
    // pressure) can also produce an empty message - but the script
    // demonstrably loaded, so a reload would loop without fixing anything.
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    expect(notifyIfWorkerScriptUnavailable({ message: '' }, true)).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('does NOT fire for a real in-worker error message that is not the wasm signature', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    expect(
      notifyIfWorkerScriptUnavailable({ message: 'TypeError: x is not a function' }, false),
    ).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('still fires for the wasm-MIME signature carried in the message, even after speaking', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    const msg =
      "Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'";
    expect(notifyIfWorkerScriptUnavailable({ message: msg }, true)).toBe(true);
    if (typeof CustomEvent === 'function') {
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
    }
  });

  it('null/undefined error from a silent spawn failure counts as empty-message', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('dispatchEvent', dispatchEvent);
    expect(notifyIfWorkerScriptUnavailable(undefined, false)).toBe(true);
  });
});
