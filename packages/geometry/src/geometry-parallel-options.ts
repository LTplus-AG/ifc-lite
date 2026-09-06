/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TessellationQuality } from './types.js';
import type { BatchSizingConfig } from './batch-sizing.js';

export interface ProcessParallelOptions {
  /**
   * Fires when the streaming pre-pass finishes building the entity index
   * (after styles), with SAB-backed Uint32Array views over the shared
   * column buffers. The parser worker uses this to skip its own
   * `scanEntitiesFastBytes` call (~10 s on 1 GB files under WASM
   * contention with the geometry workers).
   */
  onEntityIndex?: (
    ids: Uint32Array,
    starts: Uint32Array,
    lengths: Uint32Array, oversizedIdCount?: number, // #3395 refused records
    malformedRecordCount?: number, // #3790 scan stopped: 0 or 1
  ) => void;
  /**
   * Issue #540 — "Merge Multilayer Walls" load-time toggle. When
   * `true`, the geometry workers' IfcAPI receive
   * `setMergeLayers(true)` before the first stream-chunk lands, so
   * Revit-style multilayer-wall part meshes are suppressed at the
   * Rust layer. Default `false` keeps existing behaviour.
   */
  mergeLayers?: boolean;
  /**
   * GPU-instancing partition toggle (default true). Set false for FEDERATED loads:
   * the instanced render path is primary-model only, so a federated model must keep
   * all geometry on the flat path or its opaque repeated occurrences are dropped.
   */
  enableInstancing?: boolean;
  /**
   * Issue #924 — per-entity geometry-hash tolerance in metres. When a
   * positive value is given, each geometry worker's IfcAPI receives
   * `setComputeGeometryHashes(tol)` before the first stream-chunk, so the
   * RTC-invariant `geometryHash` lands on every emitted mesh for the
   * model-diff / compare feature. `undefined`/`null` ⇒ off (zero overhead).
   */
  geometryHashTolerance?: number | null;
  /**
   * Issue #976 — tessellation detail level for curved geometry. When set,
   * each geometry worker's IfcAPI receives `setTessellationQuality(level)`
   * before the first stream-chunk. `undefined`/`null` ⇒ engine default
   * (`'medium'`, output identical to the pre-quality pipeline).
   */
  tessellationQuality?: TessellationQuality | null;
  /**
   * Issue #1286 — tier-independent small-cut skip. When true, each geometry
   * worker's IfcAPI receives `setSkipSmallCuts(true)` before the first
   * stream-chunk, dropping tiny `IfcBooleanResult` detail cuts while keeping the
   * tessellation tier. `undefined`/`false` ⇒ every cut runs (default).
   */
  skipSmallCuts?: boolean;
  /**
   * Explicit URL for the wasm-bindgen `.wasm` binary. When provided,
   * forwarded to the geometry workers' init messages so they call
   * `init(wasmUrl)` instead of relying on wasm-bindgen's default
   * `import.meta.url`-based resolution.
   *
   * Vite + webpack 5 consumers don't need to set this — the bundler
   * rewrites the `new URL('ifc-lite_bg.wasm', import.meta.url)` literal
   * inside the wasm-bindgen glue at build time. This option exists for
   * consumers whose bundler doesn't transform that pattern, or who
   * serve the wasm from a CDN at a different origin (e.g., self-hosted
   * deployments, Tauri custom protocols, embedded usage).
   */
  wasmUrls?: {
    wasm?: string;
  };
  /**
   * Issue #1097 — optional override for the worker's adaptive batch sizing
   * (the watchdog↔throughput knob). Takes precedence over the `globalThis`
   * tuning hook; omitted ⇒ `DEFAULT_BATCH_SIZING`. Forwarded to every worker
   * in its `stream-start` message and validated there.
   */
  batchSizing?: Partial<BatchSizingConfig>;
  /**
   * #1097 load-time visibility filter. `disabledTypes` (uppercase STEP keywords)
   * and `skipTypeGeometry` are forwarded to the prepass so the matching geometry
   * jobs are never produced — cutting decode + CSG + tessellation + upload for
   * hidden types (spaces/annotations/grids/type-library). Takes precedence over
   * the `globalThis.__IFC_LITE_VISIBILITY_FILTER` hook. Toggling a type back on
   * requires a reload.
   */
  visibilityFilter?: { disabledTypes?: string[]; skipTypeGeometry?: boolean };
  /**
   * Explicit geometry-worker count for A/B tuning (the viewer's
   * `?geomWorkers=N` knob). Overrides the cores-tier heuristic but stays
   * clamped to the memory budget — see the worker-count policy. `undefined`
   * ⇒ use the heuristic. Lets a user measure their host's true thermal optimum
   * (which is machine-specific). Geometry output is unaffected by the count
   * (workers process disjoint, deterministic element slices).
   */
  workerCountOverride?: number;
}
