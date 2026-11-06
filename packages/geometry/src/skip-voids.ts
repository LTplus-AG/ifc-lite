// SPDX-License-Identifier: MPL-2.0
/** Apply the gross-host option without silently returning net geometry on old WASM. */
export function applySkipVoids(api: object, on: boolean): void {
  if ('setSkipVoids' in api && typeof api.setSkipVoids === 'function') {
    api.setSkipVoids(on);
  } else if (on) {
    throw new Error('skipVoids requires a WASM build with setSkipVoids support. Update @ifc-lite/wasm.');
  }
}
