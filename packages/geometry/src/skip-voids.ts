// SPDX-License-Identifier: MPL-2.0
/** Apply the gross-host option without silently returning net geometry on old WASM. */
export function applySkipVoids(api: { setSkipVoids?: (on: boolean) => void }, on: boolean): void {
  if (typeof api.setSkipVoids === 'function') {
    api.setSkipVoids(on);
  } else if (on) {
    throw new Error('skipVoids requires a WASM build with setSkipVoids support. Update @ifc-lite/wasm.');
  }
}
