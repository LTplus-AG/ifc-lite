/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const extractSweptDiskDescriptions = vi.fn();
  const extrusionDefinitions = vi.fn();
  const free = vi.fn();
  class MockIfcAPI {
    extractSweptDiskDescriptions(content: Uint8Array, ids?: Uint32Array) {
      return extractSweptDiskDescriptions(content, ids);
    }
    extrusionDefinitions(content: Uint8Array, ids?: Uint32Array) {
      return extrusionDefinitions(content, ids);
    }
    free() { free(); }
  }
  return { init: vi.fn(async () => undefined), extractSweptDiskDescriptions, extrusionDefinitions, free, MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { GeometryProcessor } from './index.js';
import { IfcLiteBridge } from './ifc-lite-bridge.js';

describe('GeometryProcessor.extractSweptDiskDescriptions (#5770)', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.extractSweptDiskDescriptions.mockReset();
    wasmMocks.extrusionDefinitions.mockReset();
    wasmMocks.free.mockReset();
  });

  it('guards an uninitialized engine and preserves unfiltered versus empty product IDs', async () => {
    const processor = new GeometryProcessor();
    const content = new Uint8Array([73, 70, 67]);
    expect(typeof processor.extractSweptDiskDescriptions).toBe('function');
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

describe('typed extrusion facades (#6306)', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.extrusionDefinitions.mockReset();
    wasmMocks.free.mockReset();
  });

  it('keeps the processor unavailable until init and forwards absent versus empty product IDs', async () => {
    const processor = new GeometryProcessor();
    const content = new Uint8Array([73, 70, 67]);
    expect(typeof processor.extractExtrusionDefinitions).toBe('function');
    expect(processor.extractExtrusionDefinitions(content)).toBeNull();
    expect(wasmMocks.extrusionDefinitions).not.toHaveBeenCalled();

    await processor.init();
    processor.extractExtrusionDefinitions(content);
    expect(wasmMocks.extrusionDefinitions).toHaveBeenLastCalledWith(content, undefined);
    const none = new Uint32Array();
    processor.extractExtrusionDefinitions(content, none);
    expect(wasmMocks.extrusionDefinitions).toHaveBeenLastCalledWith(content, none);
    expect(wasmMocks.extrusionDefinitions).toHaveBeenCalledTimes(2);
    processor.dispose();
  });

  it('forwards an explicit product selection through IfcLiteBridge', async () => {
    const bridge = new IfcLiteBridge();
    const content = new Uint8Array([73, 70, 67]);
    const ids = new Uint32Array([31]);
    expect(typeof bridge.extractExtrusionDefinitions).toBe('function');
    await bridge.init();
    bridge.extractExtrusionDefinitions(content, ids);
    expect(wasmMocks.extrusionDefinitions).toHaveBeenCalledTimes(1);
    expect(wasmMocks.extrusionDefinitions).toHaveBeenCalledWith(content, ids);
    bridge.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });
});
