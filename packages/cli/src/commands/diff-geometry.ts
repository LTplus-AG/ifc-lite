/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `--geometry` half of `ifc-lite diff --by-content` (issue #4956).
 *
 * `diff-engine.ts` builds DATA-scope fingerprints only — the Node CLI has no
 * geometry pipeline of its own, so every geometry-backed tier of
 * `@ifc-lite/diff` (`renamed` on world geometry hash, `moved`/`reshaped`,
 * split/merge, successors) abstains under `scope: 'data'`. This module is the
 * missing pipeline: it loads `@ifc-lite/wasm` LAZILY (only when `--geometry` is
 * passed — most invocations of this command never touch wasm at all), runs the
 * same mesh pass the viewer's compare uses (`setComputeGeometryHashes` +
 * `buildPrePassOnce` + `processGeometryBatch`), and attaches `geometryHash`,
 * `aabb` and `volume` to fingerprints the caller already built.
 *
 * `scripts/xmatch/fingerprints.mjs` imports this module's compiled output
 * rather than re-implementing the pass — see that file's header.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import type { DiffScope, EntityFingerprint } from '@ifc-lite/diff';
import type { IfcAPI as WasmIfcAPI } from '@ifc-lite/wasm';
import type { DiffRef } from './diff-engine.js';

/** Quantization grid for the geometry hash, in metres — the wasm default
 *  (`DEFAULT_GEOM_HASH_TOLERANCE` in `@ifc-lite/geometry`), restated here so
 *  this module has no runtime dependency on that package. */
export const GEOMETRY_HASH_TOLERANCE = 1e-3;

/** Printed (CLI) or returned (adapters) when `--geometry` cannot run because
 *  the wasm runtime is not built on this host — the `.wasm` binary is
 *  gitignored and only present after a Rust-capable build. */
export const WASM_RUNTIME_ABSENT_MESSAGE =
  '--geometry requires the @ifc-lite/wasm runtime, which is not built on this host ' +
  '(packages/wasm/pkg/ifc-lite_bg.wasm is missing). Run `pnpm build:wasm:fetch` to fetch ' +
  'a prebuilt binary, or `pnpm build:wasm` with the Rust toolchain installed.';

export interface WasmRuntime {
  api: WasmIfcAPI;
}

export type WasmRuntimeResult =
  | { ok: true; runtime: WasmRuntime }
  | { ok: false; message: string };

/**
 * Lazily load and initialize `@ifc-lite/wasm`, returning a ready `IfcAPI` with
 * geometry hashing switched on.
 *
 * Never throws: a missing `.wasm` binary, a missing package resolution, or an
 * init failure all come back as `{ ok: false, message }` so the caller can
 * report a clear, actionable message instead of a raw stack trace. Not
 * memoised — the caller owns the returned `IfcAPI` and must `.free()` it
 * (issue #4956, AGENTS.md "Geometry & WASM").
 */
export async function loadWasmRuntime(): Promise<WasmRuntimeResult> {
  let wasmPath: string;
  try {
    wasmPath = createRequire(import.meta.url).resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
  } catch {
    return { ok: false, message: WASM_RUNTIME_ABSENT_MESSAGE };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(wasmPath);
  } catch {
    return { ok: false, message: WASM_RUNTIME_ABSENT_MESSAGE };
  }

  try {
    const wasmModule = await import('@ifc-lite/wasm');
    wasmModule.initSync({ module: bytes });
    const api = new wasmModule.IfcAPI();
    api.setComputeGeometryHashes(GEOMETRY_HASH_TOLERANCE);
    return { ok: true, runtime: { api } };
  } catch (error) {
    return {
      ok: false,
      message: `${WASM_RUNTIME_ABSENT_MESSAGE} (init failed: ${(error as Error).message})`,
    };
  }
}

/** Shape of `IfcAPI.buildPrePassOnce`'s return value (untyped `any` in the
 *  wasm bindings — this is the JS object the pass actually reads). */
interface PrePassResult {
  totalJobs?: number;
  jobs?: Uint32Array;
  unitScale?: number;
  rtcOffset?: ArrayLike<number>;
  needsShift?: boolean;
  voidKeys?: Uint32Array;
  voidCounts?: Uint32Array;
  voidValues?: Uint32Array;
  styleIds?: Uint32Array;
  styleColors?: Uint8Array;
}

export interface GeometryAabb {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Per-entity world geometry hashes, boxes and volumes from one wasm mesh
 *  pass, keyed by express id. */
export interface GeometryPassResult {
  hashes: Map<DiffRef, bigint>;
  aabbs: Map<DiffRef, GeometryAabb>;
  volumes: Map<DiffRef, number>;
  unitScale: number;
}

/**
 * Run the wasm geometry pass over one file's bytes and collect per-entity
 * world hashes, boxes and volumes (issue #4956).
 *
 * Ported from `scripts/xmatch/fingerprints.mjs`'s `geometryPass` — see that
 * file's history for why each guard exists: a box with a non-finite
 * coordinate is dropped rather than passed on (a present box must be usable,
 * never a NaN the engine would classify as garbage), and a volume is kept
 * only when finite and positive (`NaN` is the wasm's "not proved closed"
 * sentinel). Every wasm handle this opens (`MeshCollection`, the pre-pass
 * cache) is freed in `finally`, so a throw mid-pass — or an `api` reused for
 * a second file right after — never leaks or carries stale state forward.
 */
export function runGeometryPass(api: WasmIfcAPI, bytes: Uint8Array): GeometryPassResult {
  const pre = api.buildPrePassOnce(bytes) as PrePassResult | undefined;
  const hashes = new Map<DiffRef, bigint>();
  const aabbs = new Map<DiffRef, GeometryAabb>();
  const volumes = new Map<DiffRef, number>();
  const unitScale = pre?.unitScale ?? 1;
  const total = pre?.totalJobs ?? 0;

  try {
    if (!pre || !pre.jobs || total === 0) return { hashes, aabbs, volumes, unitScale };

    const rtcOffset = pre.rtcOffset ? Array.from(pre.rtcOffset) : [0, 0, 0];
    const [rtcX, rtcY, rtcZ] = rtcOffset;
    const collection = api.processGeometryBatch(
      bytes,
      pre.jobs,
      pre.unitScale ?? 1,
      rtcX,
      rtcY,
      rtcZ,
      pre.needsShift ?? false,
      pre.voidKeys ?? new Uint32Array(0),
      pre.voidCounts ?? new Uint32Array(0),
      pre.voidValues ?? new Uint32Array(0),
      pre.styleIds ?? new Uint32Array(0),
      pre.styleColors ?? new Uint8Array(0),
    );
    try {
      const ids = collection.geometryHashIds;
      const values = collection.geometryHashValues;
      const boxes = collection.geometryAabbValues;
      // Optional getter (issue #4955): a wasm build that predates it answers
      // `undefined`, and volumes simply stay empty rather than throwing.
      const volumeValues = collection.geometryVolumeValues;
      for (let i = 0; i < ids.length; i++) {
        hashes.set(ids[i], values[i]);
        const volume = volumeValues?.[i];
        if (volume !== undefined && Number.isFinite(volume) && volume > 0) {
          volumes.set(ids[i], volume);
        }
        const box = Array.from(boxes.slice(6 * i, 6 * i + 6));
        if (box.length === 6 && box.every((value) => Number.isFinite(value))) {
          aabbs.set(ids[i], {
            min: [box[0], box[1], box[2]],
            max: [box[3], box[4], box[5]],
          });
        }
      }
    } finally {
      collection.free();
    }
  } finally {
    if (api.clearPrePassCache) api.clearPrePassCache();
  }
  return { hashes, aabbs, volumes, unitScale };
}

/**
 * Attach one file's geometry pass onto the fingerprints already built for it
 * (mutates in place — the fingerprints are freshly built per file, never
 * shared, so this is not a hazard).
 */
export function attachGeometryFingerprints(
  fingerprints: readonly EntityFingerprint<DiffRef>[],
  geometry: GeometryPassResult,
): void {
  for (const fingerprint of fingerprints) {
    const hash = geometry.hashes.get(fingerprint.ref);
    if (hash !== undefined) fingerprint.geometryHash = hash;
    const aabb = geometry.aabbs.get(fingerprint.ref);
    if (aabb !== undefined) fingerprint.aabb = aabb;
    const volume = geometry.volumes.get(fingerprint.ref);
    if (volume !== undefined) fingerprint.volume = volume;
  }
}

/**
 * The whole `--geometry` opt-in, as one call for `diff-content.ts`: lazily
 * load the runtime, run the pass over both files, attach it to both sets of
 * fingerprints, and report the resulting {@link DiffScope}. A missing runtime
 * is reported through `warn` (a stderr line, not a thrown error) and the
 * scope falls back to `'data'` — the rest of `--by-content` works fine
 * without geometry, exactly as it always has.
 *
 * Frees the `IfcAPI` handle in `finally`, even if a pass throws (AGENTS.md
 * "Geometry & WASM").
 */
export async function resolveGeometryScope(
  enabled: boolean,
  baseBytes: Uint8Array,
  headBytes: Uint8Array,
  baseFingerprints: readonly EntityFingerprint<DiffRef>[],
  headFingerprints: readonly EntityFingerprint<DiffRef>[],
  warn: (message: string) => void,
): Promise<DiffScope> {
  if (!enabled) return 'data';
  const runtime = await loadWasmRuntime();
  if (!runtime.ok) {
    warn(runtime.message);
    return 'data';
  }
  try {
    attachGeometryFingerprints(baseFingerprints, runGeometryPass(runtime.runtime.api, baseBytes));
    attachGeometryFingerprints(headFingerprints, runGeometryPass(runtime.runtime.api, headBytes));
    return 'both';
  } finally {
    runtime.runtime.api.free();
  }
}
