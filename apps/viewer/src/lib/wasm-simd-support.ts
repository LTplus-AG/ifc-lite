/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebAssembly SIMD support (#10784). The engine binary is built with
 * `+simd128` and there is no scalar build, so a browser without SIMD (V8 on
 * x64 CPUs lacking SSE4.1, some security modes) cannot compile it. The local
 * IFC admission refuses before the binary is fetched; the matcher backs it up
 * for any path that compiles anyway. Analytics treats the kind as benign.
 */

/**
 * A 31-byte module whose one function uses `i8x16.splat` and `i8x16.popcnt`.
 * The same probe `apps/landing`'s browser test uses: popcnt only landed with
 * the final SIMD spec, so pre-standard implementations also fail it.
 */
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
  3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** Whether this browser can compile the engine binary's SIMD instructions. Synchronous and cheap. */
export function supportsWasmSimd(): boolean {
  return typeof WebAssembly !== 'undefined' && WebAssembly.validate(WASM_SIMD_PROBE);
}

/** The local engine cannot run in this browser; thrown before anything is fetched or compiled. */
export class WasmSimdUnsupportedError extends Error {
  override name = 'WasmSimdUnsupportedError';
  constructor() { super('Wasm SIMD unsupported: this browser cannot compile the geometry engine'); }
}

/** Throw {@link WasmSimdUnsupportedError} unless the engine binary can compile here. */
export function assertWasmSimdSupported(): void {
  if (!supportsWasmSimd()) throw new WasmSimdUnsupportedError();
}

/**
 * A failure caused by missing SIMD: our own refusal (by its message prefix,
 * which the text-only analytics path also sees), else the engines' framed
 * wordings (V8 `Compiling function #N failed: Wasm SIMD unsupported`,
 * SpiderMonkey `at offset N: SIMD support is not enabled`). Framed because
 * load messages carry user-controlled file names and this kind is claimed
 * ahead of the worker and memory buckets.
 */
export function isWasmSimdUnsupportedMessage(message: string): boolean {
  return /^Wasm SIMD unsupported: |Compiling function #\d+ failed: Wasm SIMD unsupported\b|at offset \d+: SIMD support is not enabled\b/i.test(message);
}
