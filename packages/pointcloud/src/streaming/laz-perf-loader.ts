/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one lazy, memoised laz-perf (Apache-2.0) wasm loader. Shared by the
 * whole-file LAZ source and the COPC node decoder (#6869) so both pay the
 * wasm instantiation once and both honour the same test seam.
 */

import { memoizeAsync } from './memo.js';

/** @internal — exported only so the loader seam below can be typed. */
export interface LasZipInstance {
  delete(): void;
  open(ptr: number, length: number): void;
  getPoint(dest: number): void;
  getCount(): number;
  getPointLength(): number;
  getPointFormat(): number;
}

/**
 * laz-perf's per-chunk decoder: decompresses ONE LAZ chunk that starts at
 * `pointer` (a COPC node's data is exactly one chunk). It is given no
 * length; the caller owns the bounds and only asks for `pointCount` points.
 *
 * @internal — exported only so the loader seam below can be typed.
 */
export interface ChunkDecoderInstance {
  delete(): void;
  open(pointDataRecordFormat: number, pointDataRecordLength: number, pointer: number): void;
  getPoint(dest: number): void;
}

/** @internal — exported only so the loader seam below can be typed. */
export interface LazPerfModule {
  LASZip: { new (): LasZipInstance };
  ChunkDecoder: { new (): ChunkDecoderInstance };
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
}

async function importLazPerf(): Promise<LazPerfModule> {
  // The shipped `laz-perf.js` shim resolves the wasm via emscripten's
  // `locateFile` and tries `fetch("laz-perf.wasm")` relative to the
  // worker's script directory — which under Vite ends up at
  // `/assets/<chunk>.wasm` (404) or `/laz-perf.wasm` (404 → SPA index
  // HTML served as text/plain, which is what triggered the
  // "MIME type 'text/plain'" failure on autzen-classified.laz).
  //
  // Pre-fetch the wasm via Vite's `?url` asset pipeline (hashed,
  // served with `application/wasm`) and hand the bytes to emscripten
  // as `Module.wasmBinary` so its own fetch is skipped entirely.
  const wasmBinary = await fetchLazPerfWasm();

  // Dynamic import keeps `laz-perf` out of bundles that don't touch
  // LAZ. The package is shipped as CommonJS (`lib/{node,web}/index.js`),
  // and Vite/webpack wrap CJS imports under `.default` — but the way
  // they do that varies, so probe every shape we might see:
  //   • { createLazPerf }                     — pure-ESM build
  //   • { default: { createLazPerf } }        — Vite default-wrapper
  //   • { default: createLazPerf }            — esModuleInterop on a fn
  //   • module-as-function (legacy UMD)        — `lazPerf` IS the factory
  const ns = (await import('laz-perf')) as unknown as Record<string, unknown>;
  type Factory = (moduleOverrides?: Record<string, unknown>) => Promise<LazPerfModule>;
  const dflt = ns.default as Record<string, unknown> | (() => unknown) | undefined;
  const candidates: Array<unknown> = [
    ns.createLazPerf,
    typeof dflt === 'object' && dflt !== null ? (dflt as Record<string, unknown>).createLazPerf : undefined,
    dflt,
    // Some bundlers expose the CJS module as the namespace object itself.
    ns,
  ];
  const factory = candidates.find((c) => typeof c === 'function') as Factory | undefined;
  if (!factory) {
    const keys = Object.keys(ns as Record<string, unknown>).join(', ');
    throw new Error(
      `laz-perf: could not find createLazPerf factory (saw keys: ${keys || '<empty>'})`,
    );
  }
  return factory({ wasmBinary });
}

async function fetchLazPerfWasm(): Promise<Uint8Array> {
  // `?url` triggers Vite's asset pipeline so the .wasm ends up in the
  // build output with the right MIME type. Wrapped in a try/catch so
  // non-Vite hosts (e.g. node-side tests) can fall back to the package's
  // own `locateFile` resolution.
  let wasmUrl: string | undefined;
  try {
    const mod = (await import('laz-perf/lib/web/laz-perf.wasm?url')) as { default: string };
    wasmUrl = mod.default;
  } catch (err) {
    throw new Error(
      `laz-perf: could not resolve wasm asset URL (${err instanceof Error ? err.message : String(err)}). `
      + 'Ensure the bundler treats `laz-perf/lib/web/laz-perf.wasm?url` as a static asset.',
    );
  }
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`laz-perf: wasm fetch failed (${response.status} ${response.statusText}) for ${wasmUrl}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * The wasm module is instantiated once and shared by every `open()`.
 * `memoizeAsync` drops the memo if the load rejects, so a transient wasm
 * fetch failure no longer poisons every future LAZ open for the lifetime
 * of the page — the next dropped file retries.
 */
let loader = memoizeAsync(importLazPerf);

/** The shared, memoised laz-perf module. */
export function loadLazPerf(): Promise<LazPerfModule> {
  return loader();
}

/**
 * @internal E2E probe only — `tests/e2e/laz-wasm.e2e.spec.ts`. Exercises the
 * two mechanisms #2097 found unasserted: the Vite `?url` wasm-asset fetch
 * and the `Module.wasmBinary` hand-off to emscripten. Deliberately calls
 * `importLazPerf()` directly rather than the memoized `loadLazPerf` (so the
 * probe isn't affected by, and can't be swapped by, `setLazPerfLoaderForTesting`)
 * and needs no `.laz` fixture: reaching a real `LASZip` constructor proves
 * both mechanisms worked, independent of decoding any actual point data.
 */
export async function probeLazPerfWasmLoad(): Promise<
  { ok: true; hasLASZip: boolean } | { ok: false; error: string }
> {
  try {
    const mod = await importLazPerf();
    return { ok: true, hasLASZip: typeof mod.LASZip === 'function' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @internal Test seam. The real loader fetches wasm over the network and
 * instantiates an emscripten module, neither of which a unit test can
 * drive, so tests swap in a stub. Returns a restore function.
 */
export function setLazPerfLoaderForTesting(
  testLoader: () => Promise<LazPerfModule>,
): () => void {
  loader = memoizeAsync(testLoader);
  return () => {
    loader = memoizeAsync(importLazPerf);
  };
}
