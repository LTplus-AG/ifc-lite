/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const extractSweptDiskDescriptions = vi.fn();
  const free = vi.fn();
  class MockIfcAPI {
    extractSweptDiskDescriptions(content: Uint8Array, ids?: Uint32Array) {
      return extractSweptDiskDescriptions(content, ids);
    }
    free() { free(); }
  }
  return { init: vi.fn(async () => undefined), extractSweptDiskDescriptions, free, MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';

describe('GeometryProcessor.extractSweptDiskDescriptions (#5770)', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.extractSweptDiskDescriptions.mockReset();
    wasmMocks.free.mockReset();
  });

  it('guards an uninitialized engine and preserves unfiltered versus empty product IDs', async () => {
    const processor = new GeometryProcessor();
    const content = new Uint8Array([73, 70, 67]);
    expect(processor.extractSweptDiskDescriptions(content)).toBeNull();
    expect(wasmMocks.extractSweptDiskDescriptions).not.toHaveBeenCalled();

    await processor.init();

    processor.extractSweptDiskDescriptions(content);
    expect(wasmMocks.extractSweptDiskDescriptions).toHaveBeenLastCalledWith(content, undefined);
    const none = new Uint32Array();
    processor.extractSweptDiskDescriptions(content, none);
    expect(wasmMocks.extractSweptDiskDescriptions).toHaveBeenLastCalledWith(content, none);
    expect(wasmMocks.extractSweptDiskDescriptions).toHaveBeenCalledTimes(2);

    processor.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });
});
