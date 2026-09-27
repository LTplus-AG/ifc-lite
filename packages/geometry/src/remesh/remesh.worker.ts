/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Long-lived re-mesh worker (#6232 WP1). Instantiates the wasm engine ONCE,
 * then meshes subgraph buffers on request with `remeshOnApi`. Messages are
 * handled strictly in order, so a `config` posted between two requests
 * applies to the second and not the first.
 *
 * A wasm trap poisons only the `IfcAPI` that took it: that handle is dropped
 * and the next request gets a fresh one with the current config.
 */

import init, { initSync, IfcAPI } from '@ifc-lite/wasm';
import { initWasmWithRetry } from '../wasm-init-retry.js';
import { freeWasmInstanceQuietly } from '../wasm-instance-free.js';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi, type RemeshConfig } from './remesh-core.js';
import {
  meshTransferables, styleWireTransferables, type RemeshWorkerInbound, type RemeshWorkerOutbound,
} from './remesh-protocol.js';

const scope = self as unknown as Worker;
let config: RemeshConfig | null = null;
let api: IfcAPI | null = null;
let tail: Promise<void> = Promise.resolve();

function post(message: RemeshWorkerOutbound, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentApi(): IfcAPI {
  if (!config) throw new Error('remesh worker used before init');
  if (api) return api;
  const fresh = new IfcAPI();
  try {
    applyRemeshConfig(fresh, config);
  } catch (error) {
    freeWasmInstanceQuietly(fresh);
    throw error;
  }
  api = fresh;
  return fresh;
}

async function handle(message: RemeshWorkerInbound): Promise<void> {
  switch (message.type) {
    case 'init': {
      config = message.config;
      try {
        if (message.wasmModule) initSync({ module: message.wasmModule });
        else await initWasmWithRetry(() => init(message.wasmUrl), { label: 'remesh.worker' });
        currentApi();
        post({ type: 'ready' });
      } catch (error) {
        post({ type: 'init-error', message: errorMessage(error) });
      }
      return;
    }
    case 'config': {
      config = message.config;
      try {
        if (api) applyRemeshConfig(api, config);
      } catch (error) {
        // No request to answer yet: drop the half-configured handle, so the
        // next request rebuilds it and reports this same failure to its caller.
        console.error('[remesh.worker] config rejected:', errorMessage(error));
        freeWasmInstanceQuietly(api);
        api = null;
      }
      return;
    }
    case 'remesh':
    case 'style-wire': {
      try {
        if (message.type === 'remesh') {
          const result = remeshOnApi(currentApi(), message.request);
          post({ type: 'result', requestId: message.requestId, result }, meshTransferables(result.meshes));
        } else {
          const wire = styleWireOnApi(currentApi(), message.source);
          post({ type: 'style-wire', requestId: message.requestId, wire }, styleWireTransferables(wire));
        }
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) {
          freeWasmInstanceQuietly(api);
          api = null;
        }
        post({ type: 'error', requestId: message.requestId, message: errorMessage(error) });
      }
      return;
    }
  }
}

scope.onmessage = (event: MessageEvent<RemeshWorkerInbound>) => {
  const message = event.data;
  tail = tail.then(() => handle(message));
};
