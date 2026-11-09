/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Audit P7: `NativeBridge.processGeometryStreaming` listens on app-global
 * Tauri event names. Two streams running at once each received the other's
 * batches, and a `listen()` that rejected after an earlier one succeeded
 * leaked the earlier listener for the life of the app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: { payload: unknown }) => void;

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  /** Event names whose next listen() rejects. */
  refuse: new Set<string>(),
  unlistened: [] as string[],
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    if (tauri.refuse.has(name)) throw new Error(`listen ${name} refused`);
    if (!tauri.handlers.has(name)) tauri.handlers.set(name, new Set());
    tauri.handlers.get(name)?.add(handler);
    return () => {
      tauri.unlistened.push(name);
      tauri.handlers.get(name)?.delete(handler);
    };
  },
}));

import { NativeBridge } from './native-bridge.js';
import type { GeometryBatch, StreamingOptions } from './platform-bridge.js';

const emit = (name: string, payload: unknown) => {
  for (const handler of tauri.handlers.get(name) ?? []) handler({ payload });
};
const listenerCount = () => [...tauri.handlers.values()].reduce((sum, set) => sum + set.size, 0);

/** A batch whose `currentType` names the stream it was produced for. */
const batchFor = (marker: string, jobId?: string) => ({
  meshes: [],
  progress: { processed: 0, total: 0, currentType: marker },
  ...(jobId === undefined ? {} : { jobId }),
});

const stats = { totalMeshes: 0, totalVertices: 0, totalTriangles: 0, parseTimeMs: 0, geometryTimeMs: 0 };

/** A fake shell: `get_geometry_streaming` emits one batch per call, then waits for the test to finish it. */
function installShell(options: { echoJobId: boolean }) {
  const calls: Array<{ args: Record<string, unknown>; finish: () => void }> = [];
  const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    if (command !== 'get_geometry_streaming') throw new Error(`unexpected ${command}`);
    const marker = `job-${calls.length + 1}`;
    return new Promise((resolve) => {
      calls.push({
        args,
        finish: () => {
          emit('geometry-batch', batchFor(marker, options.echoJobId ? String(args.jobId) : undefined));
          resolve(stats);
        },
      });
    });
  });
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
  return { calls, invoke };
}

function collect(): { options: StreamingOptions; seen: string[] } {
  const seen: string[] = [];
  return { seen, options: { onBatch: (batch: GeometryBatch) => seen.push(batch.progress.currentType) } };
}

beforeEach(() => {
  tauri.handlers.clear();
  tauri.refuse.clear();
  tauri.unlistened = [];
});

afterEach(() => {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('NativeBridge streaming events (P7)', () => {
  it('passes a distinct job id per stream and delivers each tagged batch only to its own stream', async () => {
    const shell = installShell({ echoJobId: true });
    const bridge = new NativeBridge();
    // Two first-time dynamic imports of the mocked module racing each other
    // can reach the real one under vitest; initialise once up front.
    await bridge.init();
    const a = collect();
    const b = collect();
    const streamA = bridge.processGeometryStreaming(new Uint8Array([1]), a.options);
    const streamB = bridge.processGeometryStreaming(new Uint8Array([2]), b.options);
    await vi.waitFor(() => expect(shell.calls).toHaveLength(2));
    const [jobA, jobB] = shell.calls.map((call) => call.args.jobId);
    expect(typeof jobA).toBe('string');
    expect(jobA).not.toBe(jobB);
    shell.calls[0].finish();
    await streamA;
    shell.calls[1].finish();
    await streamB;
    expect(a.seen).toEqual(['job-1']);
    expect(b.seen).toEqual(['job-2']);
    expect(listenerCount()).toBe(0);
  });

  it('still delivers untagged batches from a shell that does not echo the job id', async () => {
    const shell = installShell({ echoJobId: false });
    const bridge = new NativeBridge();
    const a = collect();
    const stream = bridge.processGeometryStreaming(new Uint8Array([1]), a.options);
    await vi.waitFor(() => expect(shell.calls).toHaveLength(1));
    shell.calls[0].finish();
    await stream;
    expect(a.seen).toEqual(['job-1']);
  });

  it('a listen() that rejects releases the listeners already registered and sends nothing', async () => {
    const shell = installShell({ echoJobId: true });
    tauri.refuse.add('geometry-packed-batch');
    const bridge = new NativeBridge();
    const onError = vi.fn();
    await expect(bridge.processGeometryStreaming(new Uint8Array([1]), { onError })).rejects.toThrow('listen geometry-packed-batch refused');
    expect(listenerCount()).toBe(0);
    expect(tauri.unlistened).toEqual(['geometry-batch']);
    expect(shell.invoke).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
