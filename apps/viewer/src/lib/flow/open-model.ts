/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlowHost.openModel` for the viewer (`model.openFromSource`, #5634): the
 * downloaded bytes become a `File` and go through `addModel` — the canonical
 * `loadFile` pipeline every dropped or cloud-source model takes — never a
 * second ingest path. The load waits its turn on the shared source-load
 * queue, because the WASM parser must not run two loads at once.
 */

import type { FlowHost } from '@ifc-lite/flow-nodes';
import { sanitizeFilename } from '@/lib/export/download';
import { enqueueSourceLoad } from '@/lib/sources/loadQueue';

export type AddModel = (file: File, options?: { readonly name?: string; readonly modelId?: string }) => Promise<string | null>;

export type OpenModel = NonNullable<FlowHost['openModel']>;

/**
 * `isRegistered` is the store check: `addModel` returns `null` both on a real
 * failure and when a concurrent load superseded its session after the model
 * registered, so "in the store" is the success test (as `syncSourceModel`).
 */
export function createViewerOpenModel(addModel: AddModel, isRegistered: (modelId: string) => boolean): OpenModel {
  return async (bytes, name) => {
    // `name` came from a remote server: sanitize it once, before it reaches a File or the model list.
    const safeName = sanitizeFilename(name, { fallback: 'model.ifc' });
    const file = new File([bytes.slice()], safeName);
    const modelId = crypto.randomUUID();
    const added = await enqueueSourceLoad(() => addModel(file, { name: safeName, modelId }));
    if (added === null && !isRegistered(modelId)) throw new Error(`model.openFromSource: ${safeName} could not be loaded`);
    return { modelId };
  };
}
