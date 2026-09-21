/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import init from '@ifc-lite/wasm';

interface NodeModuleApi {
  createRequire(url: string): { resolve(specifier: string): string };
}

interface NodeFsApi {
  readFile(path: string): Promise<Uint8Array>;
}

/** Initialize the browser binding, including Node's file-backed wasm path. */
export async function initLandXmlWasm(): Promise<void> {
  const process = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!process?.versions?.node) {
    await init();
    return;
  }

  // Keep Node built-ins behind the runtime gate so Vite never resolves them
  // in the browser bundle.
  const nodeModule = await import(/* @vite-ignore */ 'node:module') as unknown as NodeModuleApi;
  const nodeFs = await import(/* @vite-ignore */ 'node:fs/promises') as unknown as NodeFsApi;
  const wasmPath = nodeModule.createRequire(import.meta.url).resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
  const bytes = await nodeFs.readFile(wasmPath);
  await init({ module_or_path: bytes });
}
