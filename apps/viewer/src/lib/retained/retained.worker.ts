/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadRetainedEngine, type RetainedEngine } from '../../../../../packages/wasm/retained.js';
import { RetainedInstancing } from './retainedInstancing';
import type { RetainedModelSession } from '../../../../../packages/wasm/pkg-retained/ifc-lite.js';
import { hostFailure, RETAINED_PANIC_STASH_KEY, watchUncaught, type HostPhase } from './retained-protocol';
import type { RetainedHostRequest, RetainedHostResponse } from './retained-protocol';

let engine: RetainedEngine | undefined;
let session: RetainedModelSession | undefined;
const send = (message: RetainedHostResponse, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
const realm = globalThis as Record<string, unknown>;

/** The run in progress; `reported` once its one terminal message is posted. */
let current: { runId: number; phase: HostPhase; reported: boolean } | undefined;

function report(run: NonNullable<typeof current>, error: unknown): void {
  if (run.reported) return;
  run.reported = true;
  const failure = hostFailure(error, run.phase, realm[RETAINED_PANIC_STASH_KEY] !== undefined);
  // The trapped instance is unusable; the client terminates this Worker on any error.
  if (failure.code === 'out_of_memory' && engine) send({ runId: run.runId, kind: 'workerMemory', wasmHeapBytes: engine.get_memory().buffer.byteLength });
  send({ runId: run.runId, kind: 'error', ...failure });
}

watchUncaught(self, (error) => {
  if (!current || current.reported) return false;
  report(current, error);
  return true;
});

self.onmessage = async ({ data }: MessageEvent<RetainedHostRequest>) => {
  const { runId, options } = data;
  if (current) {
    send({ runId, kind: 'error', code: 'busy', message: 'A retained model is already running' });
    return;
  }
  const run = { runId, phase: 'engine_missing' as HostPhase, reported: false };
  current = run;
  // A panic records its location here; a failed allocation never does (isAllocationFailure).
  delete realm[RETAINED_PANIC_STASH_KEY];
  try {
    engine ??= await loadRetainedEngine({ moduleUrl: '/retained-engine/pkg-retained/ifc-lite.js' });
    run.phase = 'startup';
    session ??= new engine.RetainedModelSession();
    const instancing = new RetainedInstancing(engine.encodeInstancedShard, runId, send);
    const pending = session.run(data.bytes, options, (event) => {
      run.phase = 'worker_crash';
      instancing.event(event);
    });
    // wasm-bindgen copied the input synchronously; retain no JS source during
    // the awaited product stream. The caller keeps its own original buffer.
    data.bytes = new Uint8Array();
    await pending;
    if (run.reported) return;
    instancing.flush();
    send({ runId, kind: 'workerMemory', wasmHeapBytes: engine.get_memory().buffer.byteLength });
    run.reported = true;
    send({ runId, kind: 'complete', cancelled: false });
  } catch (error) {
    report(run, error);
  } finally {
    if (current === run) current = undefined;
  }
};
