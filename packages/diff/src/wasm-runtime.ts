/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import initialize, { initSync, DiffModel } from '@ifc-lite/wasm/diff';

let ready = false;
let pending: Promise<void> | undefined;

/** Initialize once before invoking synchronous diff APIs. Failed loads may retry. */
export async function initDiff(input?: Parameters<typeof initialize>[0]): Promise<void> {
  if (ready) return;
  if (!pending) {
    pending = (async () => {
      // Node's fetch does not load file: URLs. Resolve the published asset
      // subpath here so applications share one initialization/retry boundary.
      if (input === undefined && typeof process !== 'undefined' && process.versions?.node) {
        const { readFile } = await import('node:fs/promises');
        input = { module_or_path: await readFile(new URL(import.meta.resolve('@ifc-lite/wasm/diff_bg.wasm'))) };
      }
      await initialize(input);
      ready = true;
    })().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  }
  await pending;
}

/** Initialize synchronously from preloaded bytes or a compiled WebAssembly.Module.
 * If asynchronous initialization is in progress, await initDiff() instead.
 */
export function initDiffSync(input: Parameters<typeof initSync>[0]): void {
  if (ready) return;
  if (pending) throw new Error('Asynchronous diff initialization is in progress; await initDiff() before calling synchronous diff APIs.');
  initSync(input);
  ready = true;
}

export function diffModelConstructor(): typeof DiffModel {
  if (!ready) throw new Error('Initialize @ifc-lite/diff with await initDiff() or initDiffSync() before calling synchronous diff APIs.');
  return DiffModel;
}
