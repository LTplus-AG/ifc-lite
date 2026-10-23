/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import initialize, { initSync, DiffModel } from '@ifc-lite/wasm';

let ready = false;
let pending: Promise<void> | undefined;

/** Initialize once before invoking synchronous diff APIs. Failed loads may retry. */
export async function initDiff(input?: Parameters<typeof initialize>[0]): Promise<void> {
  if (ready) return;
  if (!pending) {
    pending = initialize(input).then(() => { ready = true; }).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  }
  await pending;
}

/** Initialize synchronously from preloaded bytes or a compiled WebAssembly.Module. */
export function initDiffSync(input: Parameters<typeof initSync>[0]): void {
  if (ready) return;
  initSync(input);
  ready = true;
}

export function diffModelConstructor(): typeof DiffModel {
  if (!ready) throw new Error('Initialize @ifc-lite/diff with await initDiff() or initDiffSync() before calling synchronous diff APIs.');
  return DiffModel;
}
