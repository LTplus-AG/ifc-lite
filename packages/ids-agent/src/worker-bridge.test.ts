/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Agent side of the model bridge: lifecycle (dispose, worker death). */

import { describe, expect, it } from 'vitest';
import { createWorkerModelBridge, type BridgePort, type BridgeRequest } from './worker-bridge.js';

/** A port whose other end never answers unless told to; it can also die. */
function silentPort() {
  const posted: BridgeRequest[] = [];
  const listeners = new Map<string, Set<(event: { data?: unknown; message?: string }) => void>>();
  const port: BridgePort = {
    postMessage: (message) => { posted.push(message as BridgeRequest); },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
  };
  const emit = (type: string, event: { data?: unknown; message?: string }) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return { port, posted, emit, listenerCount };
}

const signal = () => new AbortController().signal;

describe('createWorkerModelBridge lifecycle', () => {
  it('a call after dispose rejects at once instead of hanging, and posts nothing', async () => {
    const { port, posted } = silentPort();
    const bridge = createWorkerModelBridge(port);
    const inFlight = bridge.stats(signal());
    bridge.dispose();
    await expect(inFlight).rejects.toThrow('bridge disposed');
    await expect(bridge.count({ applicability: [] }, signal())).rejects.toThrow('bridge disposed');
    expect(posted.map((m) => m.type)).toEqual(['call']);
  });

  it('dispose detaches every listener it added', () => {
    const { port, listenerCount } = silentPort();
    const bridge = createWorkerModelBridge(port, { watchErrors: true });
    expect(listenerCount()).toBeGreaterThan(0);
    bridge.dispose();
    expect(listenerCount()).toBe(0);
  });

  it('with watchErrors, a worker crash rejects every pending call and every later one', async () => {
    const { port, emit } = silentPort();
    const bridge = createWorkerModelBridge(port, { watchErrors: true });
    const a = bridge.stats(signal());
    const b = bridge.coverage({ applicabilities: [] }, signal());
    emit('error', { message: 'out of memory' });
    await expect(a).rejects.toThrow('Model bridge worker failed: out of memory');
    await expect(b).rejects.toThrow('Model bridge worker failed: out of memory');
    await expect(bridge.stats(signal())).rejects.toThrow('out of memory');
  });

  it('with watchErrors, an unreadable message rejects the pending call', async () => {
    const { port, emit } = silentPort();
    const bridge = createWorkerModelBridge(port, { watchErrors: true });
    const pending = bridge.stats(signal());
    emit('messageerror', {});
    await expect(pending).rejects.toThrow('could not be read');
  });

  it('a call whose post throws rejects alone and the bridge keeps working', async () => {
    const { port, emit, posted } = silentPort();
    let refuse = true;
    const post = port.postMessage.bind(port);
    port.postMessage = (message) => {
      if (refuse) throw new Error('DataCloneError');
      post(message);
    };
    const bridge = createWorkerModelBridge(port);
    await expect(bridge.count({ applicability: [] }, signal())).rejects.toThrow('DataCloneError');
    refuse = false;
    const ok = bridge.stats(signal());
    const call = posted.at(-1);
    emit('message', { data: { type: 'result', id: call?.type === 'call' ? call.id : -1, value: { models: [] } } });
    await expect(ok).resolves.toEqual({ models: [] });
  });

  it('a cancelled call posts cancel and its late answer is dropped', async () => {
    const { port, emit, posted } = silentPort();
    const bridge = createWorkerModelBridge(port);
    const controller = new AbortController();
    const pending = bridge.stats(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    const [call, cancel] = posted;
    expect(cancel).toEqual({ type: 'cancel', id: call.id });
    emit('message', { data: { type: 'result', id: call.id, value: 'late' } });
    await expect(bridge.stats(AbortSignal.abort())).rejects.toThrow('cancelled');
    expect(posted).toHaveLength(2);
  });
});
