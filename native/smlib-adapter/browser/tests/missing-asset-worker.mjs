// SPDX-License-Identifier: MPL-2.0
// exercise real module initialization with a genuinely absent WASM asset.
import createModule from '../ifclite_smlib_browser.mjs';
self.onmessage = async ({ data }) => {
  try {
    await createModule({ locateFile: () => new URL('./intentionally-absent.wasm', import.meta.url).href });
    self.postMessage({ id: data.id, fatal: 'unexpected missing-asset initialization success' });
  } catch (error) {
    self.postMessage({ id: data.id, fatal: `WASM initialization failed: ${String(error)}` });
  } finally { self.close(); }
};
