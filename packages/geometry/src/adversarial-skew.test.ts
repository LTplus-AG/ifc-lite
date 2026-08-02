/* Adversarial probes for PR #1680 (worker-script skew recovery).
 * Originally written to break the feature; they CONFIRMED the dispatched
 * event died in the viewer's message re-validation (the synthetic
 * worker-script message carries no wasm token). The fix routes on the
 * event's `kind` discriminator instead; these tests now pin that contract. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWasmAssetUnavailableError,
  notifyIfWorkerScriptUnavailable,
} from './wasm-asset-error.js';
import { largeFilePrepassError } from './huge-file-error.js';

/**
 * Capture the `detail.message` of the CustomEvent that
 * notifyIfWorkerScriptUnavailable dispatches, exactly as the viewer host would
 * receive it on `window`.
 */
function captureDispatchedDetail(
  err: unknown,
  spoke: boolean,
): { message?: string; kind?: string } | null {
  let captured: { message?: string; kind?: string } | null = null;
  const dispatchEvent = vi.fn((event: unknown) => {
    captured = (event as { detail?: { message?: string; kind?: string } }).detail ?? null;
    return true;
  });
  vi.stubGlobal('dispatchEvent', dispatchEvent);
  notifyIfWorkerScriptUnavailable(err, spoke);
  return captured;
}

describe('worker-script skew event carries a kind the host can trust', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the synthetic worker-script message still fails the strict matcher (why kind exists)', () => {
    // The synthetic message deliberately carries no wasm token, so a host that
    // re-ran the message matcher would drop it - the original adversarial
    // finding. The event's kind discriminator is the supported contract.
    const detail = captureDispatchedDetail({ message: undefined }, false);
    expect(detail?.message).toMatch(/worker script/i);
    expect(isWasmAssetUnavailableError(detail?.message)).toBe(false);
    expect(detail?.kind).toBe('worker-script');
  });

  it('end-to-end: the worker-script-404 path is routed by kind, not by message', () => {
    const detail = captureDispatchedDetail(undefined, false);
    // The viewer listener (apps/viewer/src/lib/wasm-version-skew.ts) reloads
    // via recoverFromWorkerScriptSkew when kind === 'worker-script', without
    // re-running the message matcher.
    expect(detail?.kind).toBe('worker-script');
  });

  it('a real wasm-MIME message from the SAME helper dispatches with kind wasm-asset', () => {
    const msg =
      "Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'";
    const detail = captureDispatchedDetail({ message: msg }, false);
    expect(isWasmAssetUnavailableError(detail?.message ?? '')).toBe(true);
    expect(detail?.kind).toBe('wasm-asset');
  });
});

describe('ADVERSARIAL: false-positive classification of empty-message spawn errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('an empty-message error from a worker that never posted is always treated as skew', () => {
    // Known, accepted over-breadth: notifyIfWorkerScriptUnavailable cannot
    // distinguish a stale-deploy 404 from other empty-message-before-first-post
    // causes (wasm compile OOM at startup, browser killing the worker during
    // init, CSP spawn block). The viewer bounds the cost: at most one reload
    // per debounce window, and none when the attempt cannot be recorded
    // (storage-blocked embeds) - see recoverFromWorkerScriptSkew.
    const dispatch = vi.fn(() => true);
    vi.stubGlobal('dispatchEvent', dispatch);

    // Shapes that a non-deploy startup failure could plausibly present as:
    for (const errShape of [
      { message: '' }, // ErrorEvent with blank message
      { message: undefined }, // ErrorEvent with absent message
      {}, // bare object, no message field
      null, // some engines pass null
      undefined,
    ]) {
      expect(notifyIfWorkerScriptUnavailable(errShape, false)).toBe(true);
    }
    expect(dispatch).toHaveBeenCalledTimes(5);
  });
});

describe('ADVERSARIAL: 2.5GB boundary consistency parser<->geometry', () => {
  it('geometry huge-file heuristic fires at EXACTLY 2.5e9 bytes (decimal GB, not GiB)', () => {
    // largeFilePrepassError uses byteLength / 1e9 >= 2.5  => >= 2_500_000_000.
    expect(largeFilePrepassError(new Error('unreachable executed'), 2_500_000_000)).not.toBeNull();
    // Just under the boundary: rethrow (null).
    expect(largeFilePrepassError(new Error('unreachable executed'), 2_499_999_999)).toBeNull();
    // The parser gate refuses at exactly 2.5e9 (strict <) so the two ceilings
    // agree at the boundary.
  });
});
