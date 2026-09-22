/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Script node's sandbox cache: one sandbox per (context, permissions),
 * but a REJECTED creation must not be cached — otherwise one transient
 * wasm-load failure makes the node dead for the lifetime of the context.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';

const createSandbox = vi.hoisted(() => vi.fn());
vi.mock('@ifc-lite/sandbox', () => ({ createSandbox }));

const { scriptNode } = await import('./script-node.js');

function ctx(bim: BimContext) {
  return { host: { bim }, laneKey: null, log: () => undefined };
}

describe('script.run sandbox cache', () => {
  it('reuses one sandbox per context, and retries after a failed creation instead of caching the rejection', async () => {
    const bim = { model: { activeId: () => 'm' } } as unknown as BimContext;
    const evalFn = vi.fn(async () => ({ value: 7, logs: [], durationMs: 1 }));
    createSandbox.mockRejectedValueOnce(new Error('wasm load failed'));
    createSandbox.mockResolvedValue({ eval: evalFn });

    const params = { code: '7', timeoutMs: 1000 };
    await expect(scriptNode.run(ctx(bim), {}, params)).rejects.toThrow('wasm load failed');

    // The retry must build a NEW sandbox rather than await the cached rejection.
    await expect(scriptNode.run(ctx(bim), {}, params)).resolves.toEqual({ result: 7 });
    await expect(scriptNode.run(ctx(bim), {}, params)).resolves.toEqual({ result: 7 });
    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(evalFn).toHaveBeenCalledTimes(2);
  });
});
