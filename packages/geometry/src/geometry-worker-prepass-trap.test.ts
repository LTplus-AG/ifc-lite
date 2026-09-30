/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WASM_PANIC_STASH_KEY } from './wasm-panic-forward.js';

const faults = vi.hoisted(() => ({ mode: 'trap', sources: [] as Uint8Array[], frees: 0 }));
function prepass(bytes: Uint8Array): void {
  faults.sources.push(bytes);
  if (faults.mode === 'trap') {
    const first = faults.sources.length === 1;
    (self as unknown as Record<string, unknown>)[WASM_PANIC_STASH_KEY] = {
      location: first ? 'original.rs:10:1' : 'retry.rs:20:1', at: Date.now(),
    };
    throw new WebAssembly.RuntimeError(first ? 'unreachable' : 'secondary trap');
  }
  if (bytes.buffer instanceof SharedArrayBuffer) throw new TypeError('shared view refused');
}
vi.mock('@ifc-lite/wasm', () => ({
  default: async () => undefined,
  initSync: () => undefined,
  IfcAPI: class {
    buildPrePassStreaming(bytes: Uint8Array) { prepass(bytes); }
    buildPrePassStreamingSharded(bytes: Uint8Array) { prepass(bytes); }
    scanEntityIndexShard(bytes: Uint8Array) {
      prepass(bytes);
      return { ids: new Uint32Array(), starts: new Uint32Array(), lengths: new Uint32Array(),
        classes: new Uint8Array(), handoff: 0 };
    }
    resolveStyledItemsShard(bytes: Uint8Array) {
      prepass(bytes);
      return { orphanIds: new Uint32Array(), orphanColors: new Float32Array(),
        geomIds: new Uint32Array(), geomColors: new Float32Array() };
    }
    finalizePrepassStyles(bytes: Uint8Array) { prepass(bytes); return {}; }
    processGeometryBatch(bytes: Uint8Array) { prepass(bytes); }
    free() { faults.frees++; }
  },
}));

const posted: Array<{ type: string; message?: string; wasmPanicLocation?: string }> = [];
beforeEach(async () => {
  faults.mode = 'trap'; faults.sources.length = 0; faults.frees = 0; posted.length = 0;
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('postMessage', (message: typeof posted[number]) => posted.push(message));
  vi.resetModules();
  await import('./geometry.worker.js');
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY];
  vi.unstubAllGlobals();
});

async function send(type: string, extra: Record<string, unknown> = {}): Promise<void> {
  (self as unknown as Worker).onmessage!({ data: {
    type, sharedBuffer: new SharedArrayBuffer(16),
    indexIds: new Uint32Array(), indexStarts: new Uint32Array(),
    indexLengths: new Uint32Array(), indexClasses: new Uint8Array(), ...extra,
  } } as MessageEvent);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('streaming prepass trap handling (#6542)', () => {
  for (const type of ['prepass-streaming', 'prepass-streaming-sharded', 'scan-shard', 'resolve-styles-shard', 'finalize-styles']) {
    it(`${type}: stops on a WASM trap before copying/replaying the file`, async () => {
      await send(type);
      expect(faults.sources).toHaveLength(1);
      expect(posted.find((m) => m.type === 'error')).toMatchObject({
        message: 'unreachable', wasmPanicLocation: 'original.rs:10:1',
      });
    });
    it(`${type}: keeps the non-trap shared-view compatibility retry`, async () => {
      faults.mode = 'view-refusal';
      await send(type);
      expect(faults.sources).toHaveLength(2);
      expect(faults.sources[0].buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(faults.sources[1].buffer).toBeInstanceOf(ArrayBuffer);
      expect(posted.filter((m) => m.type === 'error')).toHaveLength(0);
    });
  }
  it('batch traps skip the SAB copy and preserve existing per-entity recovery', async () => {
    await send('stream-start', {
      unitScale: 1, rtcX: 0, rtcY: 0, rtcZ: 0, needsShift: false,
      voidKeys: new Uint32Array(), voidCounts: new Uint32Array(), voidValues: new Uint32Array(),
      styleIds: new Uint32Array(), styleColors: new Uint8Array(),
    });
    await send('stream-chunk', { jobsFlat: Uint32Array.of(1, 0, 16) });
    expect(faults.sources).toHaveLength(1);
    expect(faults.sources[0].buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(faults.frees).toBe(1);
  });
});
