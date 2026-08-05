/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SandboxLimits.maxStackBytes` — the one resource ceiling besides the CPU
 * timeout that a script can actually be stopped by, and it had no test.
 * Removing the `runtime.setMaxStackSize(...)` call left the package suite
 * green, so nothing noticed that a configured stack ceiling was never applied.
 *
 * The recursion depth is chosen to sit BETWEEN the two states: it completes
 * under the default 512KB stack and overflows under the 8KB one. A depth that
 * overflowed in both would pass whether or not the limit is applied.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';
import { DEFAULT_LIMITS } from './types.js';

/** Recurses `n` deep and returns `n`. */
const RECURSE = (n: number) => `function f(k){ return k <= 0 ? 0 : 1 + f(k - 1); } f(${n});`;

/** Deep enough to exhaust an 8KB stack, shallow enough for the 512KB default. */
const DEPTH = 400;

async function evalWith(
  limits: { maxStackBytes?: number },
  code: string,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const sandbox = await createSandbox({} as BimContext, { limits });
  try {
    const result = await sandbox.eval(code, { typescript: false });
    return { ok: true, value: result.value };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    sandbox.dispose();
  }
}

describe('sandbox stack ceiling', () => {
  it('applies a configured maxStackBytes — recursion past it is stopped', async () => {
    const result = await evalWith({ maxStackBytes: 8 * 1024 }, RECURSE(DEPTH));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/stack overflow/i);
  });

  it('lets the SAME recursion through under the default ceiling', async () => {
    // The other half of the pair: without this, the assertion above would hold
    // just as well for a sandbox that refuses all recursion.
    const result = await evalWith({}, RECURSE(DEPTH));
    expect(result).toEqual({ ok: true, value: DEPTH });
  });

  it('applies an explicitly-passed ceiling equal to the default', async () => {
    const result = await evalWith({ maxStackBytes: DEFAULT_LIMITS.maxStackBytes }, RECURSE(DEPTH));
    expect(result).toEqual({ ok: true, value: DEPTH });
  });

  // NOT tested here: runaway recursion under the default ceiling. It does stop,
  // but the overflow leaves QuickJS holding objects with leaked refcounts and
  // the subsequent `runtime.dispose()` throws out of teardown — issue #1922,
  // upstream, with no in-repo lever. A test asserting it would be asserting the
  // bug's blast radius rather than the ceiling.

  it('publishes a 512KB default stack', () => {
    expect(DEFAULT_LIMITS.maxStackBytes).toBe(512 * 1024);
  });
});
