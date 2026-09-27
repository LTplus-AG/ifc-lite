/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RemeshClient` lifecycle (#6232 WP1). The worker is a scripted stand-in:
 * these tests pin the client's own bookkeeping (routing, ordering, dispose).
 * The wasm meshing itself is pinned by `scripts/lib/wasm-remesh-contracts.mjs`.
 */

import { describe, expect, it } from 'vitest';
import { RemeshClient } from './remesh-client.js';
import type { RemeshConfig, RemeshRequest, RemeshResult } from './remesh-core.js';
import type { RemeshWorkerInbound, RemeshWorkerOutbound } from './remesh-protocol.js';

const CONFIG: RemeshConfig = { mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true };

class ScriptedWorker {
  readonly posted: Array<{ message: RemeshWorkerInbound; transfer: Transferable[] }> = [];
  terminated = false;
  onmessage: ((event: MessageEvent<RemeshWorkerOutbound>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: RemeshWorkerInbound, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: RemeshWorkerOutbound): void {
    this.onmessage?.({ data: message } as MessageEvent<RemeshWorkerOutbound>);
  }
  requestIds(): number[] {
    return this.posted.flatMap(({ message }) => (message.type === 'remesh' ? [message.requestId] : []));
  }
}

async function started(): Promise<{ client: RemeshClient; worker: ScriptedWorker }> {
  const worker = new ScriptedWorker();
  const pending = RemeshClient.create(CONFIG, { createWorker: () => worker as unknown as Worker });
  worker.reply({ type: 'ready' });
  return { client: await pending, worker };
}

function request(buffer = new Uint8Array(8)): RemeshRequest {
  return {
    buffer,
    targets: Uint32Array.of(1),
    frame: { x: 0, y: 0, z: 0, needsShift: false },
    styleIds: new Uint32Array(),
    styleColors: new Uint8Array(),
  };
}

const result = (csgFailures: number): RemeshResult => ({ meshes: [], csgFailures, ms: { prepass: 0, produce: 0 } });

describe('RemeshClient (#6232)', () => {
  it('sends the config with init and resolves only once the engine is ready', async () => {
    const worker = new ScriptedWorker();
    let resolved = false;
    const pending = RemeshClient.create(CONFIG, { createWorker: () => worker as unknown as Worker })
      .then((client) => { resolved = true; return client; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(worker.posted[0].message).toEqual({ type: 'init', config: CONFIG, wasmModule: undefined, wasmUrl: undefined });
    worker.reply({ type: 'ready' });
    await pending;
    expect(resolved).toBe(true);
  });

  it('rejects and terminates the worker when the engine fails to start', async () => {
    const worker = new ScriptedWorker();
    const pending = RemeshClient.create(CONFIG, { createWorker: () => worker as unknown as Worker });
    worker.reply({ type: 'init-error', message: 'no wasm' });
    await expect(pending).rejects.toThrow(/no wasm/);
    expect(worker.terminated).toBe(true);
  });

  it('routes each answer to its own request, whatever order they arrive in', async () => {
    const { client, worker } = await started();
    const first = client.remesh(request());
    const second = client.remesh(request());
    const [a, b] = worker.requestIds();
    worker.reply({ type: 'error', requestId: b, message: 'kernel' });
    worker.reply({ type: 'result', requestId: a, result: result(3) });
    await expect(first).resolves.toMatchObject({ csgFailures: 3 });
    await expect(second).rejects.toThrow(/kernel/);
  });

  it('keeps a config change between the requests it was sent between', async () => {
    const { client, worker } = await started();
    void client.remesh(request());
    client.setConfig({ ...CONFIG, mergeLayers: true });
    void client.remesh(request());
    expect(worker.posted.slice(1).map(({ message }) => message.type)).toEqual(['remesh', 'config', 'remesh']);
  });

  it('transfers a whole-buffer request and copies a view into a larger buffer', async () => {
    const { client, worker } = await started();
    const whole = new Uint8Array(16);
    void client.remesh(request(whole));
    void client.remesh(request(new Uint8Array(32).subarray(4, 12)));
    expect(worker.posted[1].transfer).toEqual([whole.buffer]);
    expect(worker.posted[2].transfer).toEqual([]);
  });

  it('dispose terminates the worker and rejects what is in flight and what comes after', async () => {
    const { client, worker } = await started();
    const inFlight = client.remesh(request());
    client.dispose();
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(inFlight).rejects.toThrow(/disposed/);
    await expect(client.remesh(request())).rejects.toThrow(/disposed/);
  });

  it('a worker crash rejects every request in flight', async () => {
    const { client, worker } = await started();
    const one = client.remesh(request());
    const two = client.remesh(request());
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(one).rejects.toThrow(/boom/);
    await expect(two).rejects.toThrow(/boom/);
  });
});
