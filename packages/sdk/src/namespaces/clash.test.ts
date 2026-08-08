/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.clash.*` is where a caller's cancellation stops being a parameter and
 * starts being an engine setting (#2419). The script sandbox hands every clash
 * call an `AbortSignal` so a timed-out or disposed run does not leave the
 * engine intersecting geometry in the background — and this namespace is the
 * only thing between that signal and `ClashSettings.signal`.
 *
 * `matrix` is the seam worth pinning: it destructures its own options to pull
 * `mode` and `clearance` out onto the generated rules, and carries the rest
 * through as run settings. Adding one name to that destructure is all it takes
 * to silently drop cancellation for the whole discipline matrix, with every
 * other test in the repo still green — `run` has its own callers to notice, and
 * the sandbox's matrix coverage mocks this layer out.
 */

import { describe, expect, it } from 'vitest';
import { ClashNamespace } from './clash.js';

describe('ClashNamespace cancellation (#2419)', () => {
  it('forwards the signal from run() to the engine', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ClashNamespace().run([], [{ id: 'r', name: 'r', a: '*', b: '*', mode: 'hard' }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });

  it('forwards the signal from matrix() to the engine, past the mode/clearance split', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ClashNamespace().matrix([], { mode: 'clearance', clearance: 0.05, signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
  });

  it('completes when nothing cancels it', async () => {
    // The control: an un-aborted signal must not look like a cancelled one, so
    // the two tests above fail for the cancellation and not for reaching the
    // engine at all.
    const controller = new AbortController();
    const result = await new ClashNamespace().matrix([], { signal: controller.signal });
    expect(result.summary.total).toBe(0);
  });
});
