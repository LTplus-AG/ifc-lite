/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Headless-Node init regression test.
 *
 * The `@ifc-lite/wasm` binary is built for wasm-bindgen's `web` target, whose
 * default initializer does `fetch(new URL('ifc-lite_bg.wasm', import.meta.url))`.
 * Node's `fetch` cannot read `file://` URLs, so in a headless runtime (CLI, the
 * MCP server, SDK scripts) that path throws — which is exactly why clash
 * detection silently fell back to bounding boxes when driven through MCP.
 *
 * `IfcLiteBridge.init()` now reads the binary off disk and hands the bytes to
 * the initializer when it detects a headless Node runtime. This test pins that
 * behaviour: the initializer must be called WITH the wasm bytes, never empty.
 *
 * Skips when the wasm artifact isn't present (fresh clone before `pnpm`'s wasm
 * build / `scripts/build-wasm.sh`), per the fixture-skip convention.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wasmMock = vi.hoisted(() => {
  class MockIfcAPI {}
  return { initSpy: vi.fn(async () => undefined), MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMock.initSpy,
  IfcAPI: wasmMock.MockIfcAPI,
}));

import { IfcLiteBridge } from './ifc-lite-bridge.js';

// Resolve the real wasm binary on disk (the mock above only replaces the JS
// module — `require.resolve` still hits the package's export map).
let wasmPath: string | null = null;
try {
  wasmPath = createRequire(import.meta.url).resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
} catch {
  wasmPath = null;
}
const haveWasm = !!wasmPath && existsSync(wasmPath);

describe('IfcLiteBridge headless Node init', () => {
  afterEach(() => {
    wasmMock.initSpy.mockClear();
  });

  it.runIf(haveWasm)('feeds wasm bytes to the initializer instead of relying on fetch', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();

    expect(bridge.isInitialized()).toBe(true);
    expect(wasmMock.initSpy).toHaveBeenCalledTimes(1);

    const arg = wasmMock.initSpy.mock.calls[0][0] as { module_or_path?: unknown } | undefined;
    expect(arg).toBeTruthy();
    expect(arg?.module_or_path).toBeInstanceOf(Uint8Array);
    expect((arg?.module_or_path as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  it.skipIf(haveWasm)('is skipped when the @ifc-lite/wasm binary is absent (run pnpm build / build-wasm.sh)', () => {
    expect(haveWasm).toBe(false);
  });
});
