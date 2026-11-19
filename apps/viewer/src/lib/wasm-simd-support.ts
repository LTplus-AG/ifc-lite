/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebAssembly SIMD support (#10784). The engine binary is built with
 * `+simd128` (`.cargo/config.toml`) and there is no scalar build, so a browser
 * without SIMD cannot compile it at all. Such browsers exist even where WebGPU
 * does: V8 refuses SIMD on x64 CPUs without SSE4.1, and browser security modes
 * can turn it off. They used to get the raw `CompileError` text in the load
 * card and an unclassified PostHog issue.
 *
 * The probe lets the viewer refuse before downloading the binary; the message
 * matcher is the backstop for any path that compiles anyway.
 */

/**
 * A 30-byte module whose one function uses `i8x16.splat` and `i8x16.popcnt`.
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

/**
 * A compile failure caused by missing SIMD. V8: `Compiling function #74
 * failed: Wasm SIMD unsupported @+117554` (the reported occurrence).
 * SpiderMonkey: `SIMD support is not enabled`. Requires both a SIMD token and
 * a refusal phrase, so a message that merely mentions SIMD keeps its own kind.
 */
export function isWasmSimdUnsupportedMessage(message: string): boolean {
  return /\bsimd\b/i.test(message) && /unsupported|not (?:enabled|supported)/i.test(message);
}
