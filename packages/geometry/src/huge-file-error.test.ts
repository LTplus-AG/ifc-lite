/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { largeFilePrepassError } from './huge-file-error.js';

const GB = 1e9;

describe('largeFilePrepassError', () => {
  it.each([1649.55e6, 1778.32e6])('maps the observed pre-pass trap at %i bytes (#8259)', (bytes) => {
    const original = new WebAssembly.RuntimeError('unreachable');
    const mapped = largeFilePrepassError(original, bytes);
    expect(mapped?.message).toMatch(/out of memory/i);
    expect(mapped?.message).toContain('(underlying wasm trap: unreachable)');
    expect(mapped?.cause).toBe(original);
    expect(largeFilePrepassError(new Error('malformed STEP header'), bytes)).toBeNull();
  });

  it('maps a wasm OOM trap on a large file to an actionable error', () => {
    const e = largeFilePrepassError(new Error('unreachable executed'), 3.9 * GB);
    expect(e).not.toBeNull();
    expect(e!.message).toContain('3.9 GB');
    expect(e!.message).toContain('may exceed available WebAssembly memory');
    expect(e!.message).toMatch(/native ifc-lite CLI\/server/);
    expect(e!.message).toMatch(/4 ?GB|32-bit|WebAssembly/);
  });

  it('PRESERVES the original trap so a genuine panic on a large file is never masked', () => {
    // A Rust panic surfaces as the same `unreachable executed` as an OOM abort;
    // the mapped error must keep the original verbatim (message tail + cause) so
    // a real bug is still diagnosable, not silently relabelled "too large".
    const original = new Error('unreachable executed');
    const e = largeFilePrepassError(original, 3.9 * GB);
    expect(e).not.toBeNull();
    expect(e!.message).toContain('unreachable executed');
    expect(e!.cause).toBe(original);
  });

  it('recognises the OOM/abort signatures other engines emit', () => {
    for (const m of [
      'RuntimeError: unreachable',
      'Out of memory',
      'memory access out of bounds',
      'WebAssembly.Memory(): could not allocate memory',
      'cannot enlarge memory arrays',
      'grow memory failed',
    ]) {
      expect(largeFilePrepassError(new Error(m), 3 * GB), m).not.toBeNull();
    }
  });

  it('does NOT hijack a small-file failure (rethrow the original)', () => {
    // Below the heuristic threshold, preserve the original failure.
    expect(largeFilePrepassError(new Error('unreachable executed'), 0.5 * GB)).toBeNull();
  });

  it('leaves a genuine panic (stashed location) unmapped, without consuming the stash', () => {
    const realm = { __ifclite_wasm_panic: { location: 'geometry/src/mesh_weld.rs:412:9', at: Date.now() } };
    expect(largeFilePrepassError(new Error('unreachable executed'), 1.7 * GB, realm)).toBeNull();
    expect(realm.__ifclite_wasm_panic).toBeDefined();
    expect(largeFilePrepassError(new Error('unreachable executed'), 1.7 * GB, {})).not.toBeNull();
  });

  it('does NOT hijack an unrelated error on a large file', () => {
    expect(largeFilePrepassError(new Error('malformed STEP header'), 3.9 * GB)).toBeNull();
  });

  it('handles non-Error throwables', () => {
    expect(largeFilePrepassError('unreachable', 3 * GB)).not.toBeNull();
  });

  it('is inclusive at the 1.0 GB threshold', () => {
    expect(largeFilePrepassError(new Error('unreachable'), 1.0 * GB)).not.toBeNull();
    expect(largeFilePrepassError(new Error('unreachable'), 0.99 * GB)).toBeNull();
  });
});
