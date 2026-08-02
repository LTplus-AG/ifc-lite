import { describe, expect, it } from 'vitest';
import { largeFilePrepassError } from './huge-file-error.js';

const GB = 1e9;

describe('largeFilePrepassError', () => {
  it('maps a wasm OOM trap on a large file to an actionable error', () => {
    const e = largeFilePrepassError(new Error('unreachable executed'), 3.9 * GB);
    expect(e).not.toBeNull();
    expect(e!.message).toContain('3.9 GB');
    expect(e!.message).toMatch(/desktop app/);
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
    // A trap on a 0.5GB file is a real bug, not the size ceiling — must pass through.
    expect(largeFilePrepassError(new Error('unreachable executed'), 0.5 * GB)).toBeNull();
  });

  it('does NOT hijack an unrelated error on a large file', () => {
    expect(largeFilePrepassError(new Error('malformed STEP header'), 3.9 * GB)).toBeNull();
  });

  it('handles non-Error throwables', () => {
    expect(largeFilePrepassError('unreachable', 3 * GB)).not.toBeNull();
  });

  it('is inclusive at the 2.5 GB threshold', () => {
    expect(largeFilePrepassError(new Error('unreachable'), 2.5 * GB)).not.toBeNull();
    expect(largeFilePrepassError(new Error('unreachable'), 2.4 * GB)).toBeNull();
  });
});
