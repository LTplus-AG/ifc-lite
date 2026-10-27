// SPDX-License-Identifier: MPL-2.0
// Emscripten-shaped allocation peer. Echoes opaque frames through the real
// browser dispatchOwned/worker; implements no SMLib operation or geometry.
import { readFile } from 'node:fs/promises';
export default async function createModule(options = {}) {
  if (options.locateFile) await readFile(new URL(options.locateFile('fixture.wasm')));
  await new Promise(done => setTimeout(done, 20));
  let cursor = 32;
  const module = {
    HEAPU8: new Uint8Array(4 * 1024 * 1024),
    _malloc(size) { const result = cursor; cursor += size; return result; },
    _free() {},
    _ifclite_smlib_dispatch_owned(request, size, output, length) {
      const response = module._malloc(size);
      module.HEAPU8.set(module.HEAPU8.slice(request, request + size), response);
      const view = new DataView(module.HEAPU8.buffer);
      view.setUint32(output, response, true);
      view.setUint32(length, size, true);
      return 0;
    },
  };
  return module;
}
