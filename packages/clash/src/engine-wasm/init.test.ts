/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `initClashWasm`: one instantiation per realm, retried after a failure. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => ({ init: vi.fn<(input?: unknown) => Promise<unknown>>() }));
vi.mock('@ifc-lite/wasm', () => ({ default: wasm.init, ClashSession: class {} }));

beforeEach(() => {
  vi.resetModules();
  wasm.init.mockReset();
});

describe('initClashWasm', () => {
  it('concurrent calls instantiate once, and a later call does not instantiate again', async () => {
    let finish!: () => void;
    wasm.init.mockReturnValue(new Promise((resolve) => { finish = () => resolve({}); }));
    const { initClashWasm } = await import('./index.js');
    const both = Promise.all([initClashWasm(), initClashWasm()]);
    finish();
    await both;
    await initClashWasm();
    expect(wasm.init).toHaveBeenCalledTimes(1);
  });

  it('a failed instantiation is retried by the next call, with that call\'s input', async () => {
    wasm.init.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
    const { initClashWasm } = await import('./index.js');
    await expect(initClashWasm()).rejects.toThrow('network');
    const bytes = new Uint8Array([0, 97, 115, 109]);
    await initClashWasm(bytes);
    expect(wasm.init).toHaveBeenNthCalledWith(2, { module_or_path: bytes });
  });
});
