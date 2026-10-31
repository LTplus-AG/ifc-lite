/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * F2 (#8341), dedicated prepass worker: the omitted-type-record count lives on
 * the IfcAPI that ran the streaming prepass, and a later content install on
 * that instance resets it. The worker must therefore read it while the prepass
 * `complete` event is being delivered and carry it on that event. Drives the
 * real worker message handler with a mocked wasm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  const state = { hasGetter: true, omitted: 2 as number | undefined, report: undefined as unknown, instances: 0 };
  function run(onEvent: (event: unknown) => void) {
    // Rust: the type plan notes its omissions before `complete` is emitted.
    state.report = state.omitted === undefined ? undefined : { schemaVersion: 1, omittedTypeRecords: state.omitted };
    onEvent({ type: 'jobs', jobs: new Uint32Array([1, 0, 1]) });
    onEvent({ type: 'complete', totalJobs: 1 });
    state.report = undefined; // a later install (setSourceBytes etc.) resets it
  }
  class MockIfcAPI {
    getPipelineDiagnostics?: () => unknown;
    constructor() {
      state.instances++;
      if (state.hasGetter) this.getPipelineDiagnostics = () => state.report;
    }
    buildPrePassStreaming(_bytes: Uint8Array, onEvent: (event: unknown) => void) { run(onEvent); }
    buildPrePassStreamingSharded(_bytes: Uint8Array, onEvent: (event: unknown) => void) { run(onEvent); }
    free() {}
  }
  return { state, MockIfcAPI };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: async () => undefined,
  initSync: () => undefined,
  setGeometryProgressCallback: () => undefined,
  IfcAPI: wasm.MockIfcAPI,
}));

type Posted = { type: string; event?: Record<string, unknown> };
const posted: Posted[] = [];

beforeEach(async () => {
  wasm.state.hasGetter = true;
  wasm.state.omitted = 2;
  wasm.state.report = undefined;
  posted.length = 0;
  vi.stubGlobal('self', globalThis);
  vi.stubGlobal('postMessage', (message: Posted) => posted.push(message));
  vi.resetModules();
  await import('./geometry.worker.js');
});
afterEach(() => vi.unstubAllGlobals());

async function send(type: string): Promise<void> {
  (self as unknown as Worker).onmessage!({ data: {
    type, sharedBuffer: new SharedArrayBuffer(16),
    indexIds: new Uint32Array(), indexStarts: new Uint32Array(),
    indexLengths: new Uint32Array(), indexClasses: new Uint8Array(),
  } } as MessageEvent);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const prepassEvents = () => posted.filter((m) => m.type === 'prepass-stream').map((m) => m.event!);

describe('prepass worker relays omitted type records on complete (#8341)', () => {
  for (const type of ['prepass-streaming', 'prepass-streaming-sharded']) {
    it(`${type}: complete carries the count read from the prepass instance before any reset`, async () => {
      await send(type);
      expect(posted.filter((m) => m.type === 'error')).toEqual([]);
      const [jobs, complete] = prepassEvents();
      expect(jobs.type).toBe('jobs');
      expect('omittedTypeRecords' in jobs).toBe(false);
      expect(complete).toMatchObject({ type: 'complete', totalJobs: 1, omittedTypeRecords: 2 });
    });

    it(`${type}: an older wasm without the getter posts complete without the key`, async () => {
      wasm.state.hasGetter = false;
      await send(type);
      const complete = prepassEvents().find((e) => e.type === 'complete')!;
      expect(complete).toEqual({ type: 'complete', totalJobs: 1 });
    });

    it(`${type}: no report (nothing recorded, or a wasm before #8350) stays unknown, not 0`, async () => {
      wasm.state.omitted = undefined;
      await send(type);
      const complete = prepassEvents().find((e) => e.type === 'complete')!;
      expect('omittedTypeRecords' in complete).toBe(false);
    });
  }
});
