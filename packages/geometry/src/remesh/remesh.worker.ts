/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Long-lived re-mesh worker (#6232 WP1). Instantiates the wasm engine ONCE,
 * then meshes subgraph buffers on request with `remeshOnApi`. Messages are
 * handled strictly in order, so a `config` posted between two requests
 * applies to the second and not the first.
 *
 * A failed request drops its `IfcAPI`: cleanup may trap independently of
 * the primary error. The next request gets a fresh handle with current config.
 */

import init, { initSync, IfcAPI } from '@ifc-lite/wasm';
import { initWasmWithRetry } from '../wasm-init-retry.js';
import { freeWasmInstanceQuietly } from '../wasm-instance-free.js';
import { restashWasmPanicLocation, takeWasmPanicStash } from '../wasm-panic-forward.js';
import { applyRemeshConfig, remeshOnApi, styleWireOnApi, type RemeshConfig } from './remesh-core.js';
import {
  meshTransferables, serialQueue, styleWireTransferables, type RemeshWorkerInbound, type RemeshWorkerOutbound,
} from './remesh-protocol.js';

const scope = self as unknown as Worker;
let config: RemeshConfig | null = null;
let api: IfcAPI | null = null;

function post(message: RemeshWorkerOutbound, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown) {
  const panic = takeWasmPanicStash(scope);
  return { message: errorMessage(error), wasmPanicLocation: panic?.location, wasmPanicAt: panic?.at };
}

function freeFailedApi(instance: IfcAPI | null): void {
  freeWasmInstanceQuietly(instance);
  takeWasmPanicStash(scope); // A cleanup panic must not label the next operation.
}

function currentApi(): IfcAPI {
  if (!config) throw new Error('remesh worker used before init');
  if (api) return api;
  const fresh = new IfcAPI();
  try {
    applyRemeshConfig(fresh, config);
  } catch (error) {
    const panic = takeWasmPanicStash(scope);
    freeFailedApi(fresh);
    if (panic) restashWasmPanicLocation(scope, panic.location, panic.at, errorMessage(error));
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
        post({ type: 'init-error', ...errorDetails(error) });
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
        // This failure has no request to capture; don't label a later trap.
        takeWasmPanicStash(scope);
        freeFailedApi(api);
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
        // Capture before freeing: cleanup of a poisoned handle can trap too.
        const details = errorDetails(error);
        // A non-trap primary error may hide a secondary cleanup trap.
        freeFailedApi(api);
        api = null;
        post({ type: 'error', requestId: message.requestId, ...details });
      }
      return;
    }
  }
}

// `handle` answers every request itself; this only guards the queue against
// an escape it did not anticipate, which would otherwise stall it for good.
const enqueue = serialQueue(handle, (error) => console.error('[remesh.worker] unhandled:', errorMessage(error)));
scope.onmessage = (event: MessageEvent<RemeshWorkerInbound>) => enqueue(event.data);
