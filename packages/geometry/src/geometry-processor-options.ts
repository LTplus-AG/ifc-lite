// SPDX-License-Identifier: MPL-2.0
import type { TessellationQuality } from './types.js';

export interface GeometryProcessorOptions {
  preferNative?: boolean; // Default: true in Tauri
  /**
   * When true, the underlying IFC-Lite WASM API merges Revit-style
   * multilayer walls — `IfcBuildingElementPart` meshes whose parent
   * wall is sliceable are suppressed. Default `false` keeps the
   * existing per-layer rendering behaviour. See issue #540.
   */
  mergeLayers?: boolean;
  /**
   * GPU-instancing partition toggle (default true). Set false for FEDERATED loads:
   * the renderer's instanced path is primary-model only, so a federated model must
   * keep all geometry on the flat path or its opaque repeated occurrences are dropped.
   */
  enableInstancing?: boolean;
  /**
   * Tessellation detail level for curved geometry (issue #976):
   * `'lowest' | 'low' | 'medium' | 'high' | 'highest'`. Unset/`'medium'`
   * reproduces the engine's historical densities byte-for-byte. Lower
   * levels trade curved-surface smoothness for throughput; higher levels
   * reduce faceting on pipes / cylinders / NURBS at a proportional
   * triangle-count cost. Applies to the WASM paths (main-thread, streaming
   * and worker-pool); the native desktop path does not consume it yet.
   */
  tessellationQuality?: TessellationQuality;
  /**
   * Tier-independent small-cut skip (issue #1286). When true, the WASM mesh pass
   * drops `IfcBooleanResult` differences whose cutter is tiny relative to its
   * host (steel copes/notches, minor detail recesses) WITHOUT lowering the
   * tessellation tier — so curves keep full density while the dominant
   * boolean-heavy load cost is skipped. Default false ⇒ every cut runs
   * (byte-identical to before). The viewer enables it for the on-screen load;
   * exporters/drawings leave it off so their geometry stays full fidelity.
   */
  skipSmallCuts?: boolean;
  /** Skip IfcRelVoidsElement cuts for gross hosts; preserve authored booleans and fillings.
   * Default false. Requires WASM; use preferNative: false in a Tauri host. */
  skipVoids?: boolean;
}

