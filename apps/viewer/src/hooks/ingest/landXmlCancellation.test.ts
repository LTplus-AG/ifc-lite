/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLandXmlViewerModelAsync, parseLandXmlViewerModelFromBlobAsync } from './landXmlViewerModel.js';

it('refuses stale worker-less LandXML parsing before initializing WASM (#5041)', async () => {
  const originalWorker = globalThis.Worker;
  try {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
    await assert.rejects(
      parseLandXmlViewerModelAsync(new ArrayBuffer(8), () => false),
      /LandXML parsing cancelled/,
    );
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});

it('terminates LandXML worker parsing within the cancellation polling bound (#5041)', async () => {
  const originalWorker = globalThis.Worker;
  let terminated = 0;
  class PendingWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(): void {}
    terminate(): void { terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: PendingWorker as unknown as typeof Worker,
  });
  let current = true;
  const started = performance.now();
  try {
    const pending = parseLandXmlViewerModelAsync(new ArrayBuffer(8), () => current);
    current = false;
    await assert.rejects(pending, /LandXML parsing cancelled/);
    assert.equal(terminated, 1);
    assert.ok(performance.now() - started < 250, 'cancellation must not wait for synchronous WASM completion');
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});

it('holds the second cursor pass until main has acknowledged preflight (#5050)', async () => {
  const originalWorker = globalThis.Worker;
  const workers: PreflightWorker[] = [];
  class PreflightWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly posted: unknown[] = [];
    constructor() { workers.push(this); }
    postMessage(message: unknown): void {
      this.posted.push(message);
      if (this.posted.length === 1) queueMicrotask(() => this.onmessage?.({ data: {
        preflight: { componentCount: 1, frame: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false } },
      } } as MessageEvent<unknown>));
    }
    terminate(): void {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: PreflightWorker as unknown as typeof Worker });
  let approve: (() => void) | undefined;
  try {
    const pending = parseLandXmlViewerModelFromBlobAsync(
      new Blob(['<LandXML/>']),
      () => true,
      undefined,
      () => new Promise<void>((resolve) => { approve = resolve; }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.equal(workers[0]?.posted.length, 1, 'worker must not begin pass two before reservation approval');
    approve?.();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    assert.deepEqual(workers[0]?.posted[1], { type: 'preflight-approved' });
    workers[0]?.onmessage?.({ data: { ok: false, error: 'stop after handshake' } } as MessageEvent<unknown>);
    await assert.rejects(pending, /stop after handshake/);
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});

it('rejects and terminates when a synchronous preflight callback fails (#5050)', async () => {
  const originalWorker = globalThis.Worker;
  let terminated = 0;
  class PreflightWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(): void {
      queueMicrotask(() => this.onmessage?.({ data: {
        preflight: { componentCount: 1, frame: null },
      } } as MessageEvent<unknown>));
    }
    terminate(): void { terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: PreflightWorker as unknown as typeof Worker });
  try {
    await assert.rejects(
      parseLandXmlViewerModelFromBlobAsync(new Blob(['<LandXML/>']), () => true, undefined, () => {
        throw new Error('reservation failed');
      }),
      /reservation failed/,
    );
    assert.equal(terminated, 1, 'a rejected callback must release the worker rather than strand the load');
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});

it('acknowledges each federated preflight and raw component before the next worker phase (#5050)', async () => {
  const originalWorker = globalThis.Worker;
  const workers: FederatedWorker[] = [];
  const component = {
    expressId: 1, positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 1, 0]),
    indices: new Uint32Array([0, 0, 0]), color: [0.42, 0.62, 0.32, 1], origin: [0, 0, 0],
  };
  class FederatedWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly posted: unknown[] = [];
    constructor() { workers.push(this); }
    postMessage(message: unknown): void {
      this.posted.push(message);
      const reply = (data: unknown) => queueMicrotask(() => this.onmessage?.({ data } as MessageEvent<unknown>));
      if (this.posted.length === 1) reply({
        preflight: { componentCount: 1, frame: null }, sourceCoordinateInfo: {
          originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
          shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, hasLargeCoordinates: false,
        },
      });
      else if (this.posted.length === 2) reply({ preflightComponent: component });
      else if (this.posted.length === 3) reply({ preflightComplete: true });
      else if (this.posted.length === 4) reply({ component });
      else if (this.posted.length === 5) reply({ ok: false, error: 'stop after federated acknowledgements' });
    }
    terminate(): void {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FederatedWorker as unknown as typeof Worker });
  const phases: string[] = [];
  try {
    const pending = parseLandXmlViewerModelFromBlobAsync(
      new Blob(['<LandXML/>']),
      () => true,
      undefined,
      undefined,
      () => { phases.push('raw'); },
      () => { phases.push('preflight'); },
      () => { phases.push('measure'); },
      () => { phases.push('freeze'); },
    );
    await assert.rejects(pending, /stop after federated acknowledgements/);
    assert.deepEqual(phases, ['preflight', 'measure', 'freeze', 'raw']);
    assert.deepEqual((workers[0]?.posted[0] as { streamFederatedPreflight?: boolean }).streamFederatedPreflight, true);
    assert.deepEqual(workers[0]?.posted.slice(1), [
      { type: 'preflight-approved' }, { type: 'component-uploaded' },
      { type: 'preflight-approved' }, { type: 'component-uploaded' },
    ]);
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});
