/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Under Node, read a wasm binary from an installed package; elsewhere return
 * `undefined` so wasm-bindgen resolves and fetches it itself. Node's fetch()
 * cannot load the file:// URL the generated glue derives from import.meta.url.
 * Node-only modules are imported via variable + `@vite-ignore` so the browser
 * bundler never resolves them, and stay untyped: this package has no @types/node.
 */
export async function readNodeWasmBytes(specifier: string): Promise<BufferSource | undefined> {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!proc?.versions?.node || typeof window !== 'undefined') return undefined;
  const moduleSpecifier = 'node:module';
  const fsSpecifier = 'node:fs/promises';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeModule: any = await import(/* @vite-ignore */ moduleSpecifier);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeFs: any = await import(/* @vite-ignore */ fsSpecifier);
  const path: string = nodeModule.createRequire(import.meta.url).resolve(specifier);
  return (await nodeFs.readFile(path)) as BufferSource;
}
