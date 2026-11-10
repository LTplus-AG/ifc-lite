/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-Lite bridge - initializes and manages IFC-Lite WASM for geometry processing
 * Replaces web-ifc-bridge.ts with native IFC-Lite implementation (1.9x faster)
 */

import { applySkipVoids } from './skip-voids.js';
import { createLogger } from '@ifc-lite/data';
import { runDomainExport } from './domain-export-call.js';
import type { KmzAltitudeMode, TessellationQuality } from './types.js';
import type { RtcFrame } from './rtc-frame.js';
import type { HbjsonStats } from './hbjson-stats.js';
import * as energyExport from './energy-export-bridge.js';
import { callExportLandXmlTerrain, type LandXmlTerrainExport, type LandXmlTerrainExportOptions } from './landxml-terrain-export.js';
import type { GeometryDiagnostics } from './diagnostics.js';
import { readNodeWasmBytes } from './node-wasm-bytes.js';
import type { ExtrusionDefinitions, SweptDiskDescriptions } from './analytic-descriptions.js';
import { initMainThreadEngine } from './main-engine-init.js';
import { createLifetime, type LifetimeAttempt } from '@ifc-lite/wasm-lifecycle';
import {
  isWasmRuntimeTrap,
  notifyWasmRuntimeUnrecoverable,
  wasmRuntimeUnrecoverableError,
} from './wasm-runtime-trap.js';
import { initWasmWithRetry } from './wasm-init-retry.js';
import init, {
  IfcAPI,
  SymbolicRepresentationCollection,
  SymbolicPolyline,
  SymbolicCircle,
  ProfileCollection,
  ProfileEntryJs,
  GridAxisCollection,
  GridAxisJs,
} from '@ifc-lite/wasm';
export type {
  SymbolicRepresentationCollection,
  SymbolicPolyline,
  SymbolicCircle,
  ProfileCollection,
  ProfileEntryJs,
  GridAxisCollection,
  GridAxisJs,
};

const log = createLogger('Geometry');

/**
 * Typed wrapper for optional engine controls that are not part of the
 * generated `IfcAPI` declaration yet.
 */
type IfcAPIWithMerge = IfcAPI & {
  setMergeLayers?: (enabled: boolean) => void;
  setComputeGeometryHashes?: (tolerance?: number | null) => void;
  setTessellationQuality?: (level?: string | null) => void;
  setSkipSmallCuts?: (on: boolean) => void;
};

export class IfcLiteBridge {
  private ifcApi: IfcAPI | null = null;
  /** Single-flight, generation-checked init (audit P6; contract on `createLifetime`). */
  private readonly lifetime = createLifetime<void>({
    start: (attempt) => this.startEngine(attempt),
    supersededError: () => new Error('IfcLiteBridge.init() was superseded by dispose() before it finished'),
  });
  /**
   * When true, the WASM mesh emitters drop `IfcBuildingElementPart`
   * meshes whose parent wall is sliceable (Revit-style multilayer
   * walls). Layer colour info is preserved on the parent solid. The
   * flag is forwarded to the underlying IfcAPI on `init` and on every
   * `setMergeLayers` call; consumers can still read it back via the
   * getter for telemetry / UI badges.
   */
  private mergeLayers: boolean = false;
  /**
   * Per-entity geometry-hash tolerance in metres, or `null` when
   * fingerprinting is off (the default — zero overhead). When set, the
   * WASM mesh pass emits an RTC-invariant `geometryHashValues` array used
   * by the model-diff / compare feature (issue #924). Cached here and
   * forwarded to the IfcAPI on `init` + every `setComputeGeometryHashes`
   * call, mirroring the `mergeLayers` replay pattern.
   */
  private geometryHashTolerance: number | null = null;
  /**
   * Tessellation detail level (issue #976), or `null` for the engine
   * default (`'medium'`, byte-for-byte identical to the pre-quality
   * pipeline). Cached here and forwarded to the IfcAPI on `init` + every
   * `setTessellationQuality` call, mirroring the `mergeLayers` replay
   * pattern.
   */
  private tessellationQuality: TessellationQuality | null = null;
  /**
   * Tier-independent small-cut skip (#1286). When true, the WASM mesh pass drops
   * tiny `IfcBooleanResult` detail cuts (steel copes/notches) WITHOUT lowering
   * the tessellation tier, so curves keep full density. Cached here and forwarded
   * to the IfcAPI on `init` + every `setSkipSmallCuts` call, mirroring the
   * `mergeLayers` replay pattern. Default false ⇒ every cut runs.
   */
  private skipSmallCuts: boolean = false;
  private skipVoids = false;

  private isWasmRuntimeError(error: unknown): boolean {
    return isWasmRuntimeTrap(error);
  }

  /** After a runtime trap, drop this bridge's potentially wedged IfcAPI and
   * its per-load caches behind mutexes (#1898). The caller still gets the
   * original error; a later init() builds a fresh handle. Do not latch a
   * realm-wide failure: that previously bricked unrelated consumers even
   * while their already-initialized bridges continued working. */
  private recordWasmRuntimeTrap(): void {
    this.disposeBestEffort();
  }

  /**
   * Free the WASM handle if one exists, best-effort, then drop the JS-side
   * reference either way. `free()` runs Rust code — if the runtime just
   * trapped (or is what's trapping), `free()` itself can throw or trap
   * again, so any failure here is logged (never rethrown) and we fall back
   * to just nulling the reference via `reset()`. This never throws: callers
   * rely on that so a secondary `free()` failure can never replace/mask
   * whatever error the caller is already unwinding with.
   */
  private disposeBestEffort(): void {
    try {
      this.dispose();
    } catch (error) {
      // Freeing can trap again if the allocator is what trapped: drop the
      // reference anyway and report via `log.error` (guarded, since a
      // throwing logger would break this method's never-throw contract).
      try {
        log.error('Secondary failure while disposing WASM handle', error, {
          operation: 'disposeBestEffort',
        });
      } catch {
        // A logger that throws must not escape this best-effort path either.
      }
      this.reset();
    }
  }

  /**
   * Initialize IFC-Lite WASM
   * The WASM binary is automatically resolved from the same location as the JS module
   */
  init(): Promise<void> {
    // Concurrent callers share one attempt; one overtaken by dispose() rejects.
    return this.lifetime.init();
  }

  private async startEngine(attempt: LifetimeAttempt): Promise<void> {
    try {
      // In the browser/worker, wasm-bindgen resolves and fetches the .wasm
      // itself; under Node the bytes are read from the installed package.
      const wasmInitArg = await readNodeWasmBytes('@ifc-lite/wasm/ifc-lite_bg.wasm');
      // Raw package resolution and Node's supplied bytes retain their paths; the
      // browser path joins the realm's one main-thread init (#7036), which a host
      // may already have started when the load was requested.
      if (wasmInitArg) {
        await initWasmWithRetry(async () => { await init({ module_or_path: wasmInitArg }); }, { label: 'ifc-lite-bridge' });
      } else {
        await initMainThreadEngine();
      }

      // The WASM bundle has no in-WASM thread pool; rayon `par_iter()`
      // (e.g. FacetedBrep preprocessing) runs sequentially on the main
      // thread. Cross-worker parallelism is provided at a higher level by
      // the N-worker pool in `geometry-parallel.ts`.
      log.debug('Geometry processing: single-threaded WASM (N-worker pool handles parallelism)');

      // dispose() landed while the engine loaded: build no handle; the lifetime
      // rejects this attempt as superseded instead of resurrecting the bridge.
      if (!attempt.isCurrent()) return;
      this.ifcApi = new IfcAPI();
      // Re-apply the cached merge-layers flag so callers can call
      // `setMergeLayers(true)` BEFORE `init()` and still get the
      // expected behaviour on the freshly-constructed IfcAPI.
      this.applyMergeLayers();
      this.applyComputeGeometryHashes();
      this.applyTessellationQuality();
      this.applySkipSmallCuts();
      applySkipVoids(this.ifcApi, this.skipVoids);
      log.info('WASM geometry engine initialized');
    } catch (error) {
      log.error('Failed to initialize WASM geometry engine', error, {
        operation: 'init',
      });
      // A stale attempt (overtaken by dispose()) never built a handle; its
      // cleanup must not free or supersede the attempt that replaced it.
      if (!attempt.isCurrent()) throw error;
      // An `apply*` replay after `new IfcAPI()` can throw or trap: free the
      // handle built here (a nulled one no `dispose()` can reach would leak
      // for the life of the document). Best-effort and never throws, so it
      // cannot mask the error below, including the fatal trap branch, which
      // follows the same "free the handle, propagate the trap" contract as
      // `recordWasmRuntimeTrap`.
      this.disposeBestEffort();
      if (this.isWasmRuntimeError(error)) {
        // The engine trapped while standing itself up: report it freshly
        // constructed (stack = this throw site, trap as `cause`) and tell the
        // host, which offers a reload. Advisory, not a latch: a later `init()`
        // still tries, so no unrelated consumer is disabled by it. (#1898)
        const fatal = wasmRuntimeUnrecoverableError(error, 'init');
        notifyWasmRuntimeUnrecoverable(fatal);
        throw fatal;
      }
      throw error;
    }
  }

  /**
   * Reset the JS wrapper state.
   * This does not reload wasm-bindgen's module singleton after a fatal WASM panic.
   */
  reset(): void {
    this.lifetime.reset();
    this.ifcApi = null;
  }

  /**
   * Free the underlying WASM `IfcAPI` handle deterministically (AGENTS.md
   * "Free every WASM handle deterministically"). `clearPrePassCache` only
   * drops the per-load caches held *inside* the handle; the handle itself
   * (and everything still cached on it — see the poisoned-mutex recovery
   * note in `IfcAPI`) is only released here, via wasm-bindgen's generated
   * `free()`, when the whole bridge is being torn down.
   *
   * Idempotent (the reference is nulled right after freeing, so no
   * double-free) and safe before `init()` or after a trap nulled the handle.
   * An `init()` still in flight rejects instead of resurrecting the bridge;
   * a later `init()` builds a fresh handle (audit P6).
   */
  dispose(): void {
    this.lifetime.dispose();
    // reset() even if free() throws, so the next init() rebuilds.
    try { this.ifcApi?.free(); } finally { this.reset(); }
  }

  /**
   * `using bridge = new IfcLiteBridge()` support (TS 5.2+ / ES2022 target):
   * frees the WASM handle deterministically at scope exit.
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * Parse IFC content and return symbolic representations (Plan, Annotation, FootPrint)
   * These are pre-authored 2D curves for architectural drawings
   */
  parseSymbolicRepresentations(content: string, frame?: RtcFrame): SymbolicRepresentationCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const api = this.ifcApi as IfcAPIWithMerge;
      const collection = frame === undefined
        ? api.parseSymbolicRepresentations(content)
        : api.parseSymbolicRepresentationsInFrame(content, { ...frame });
      log.debug(`Parsed ${collection.totalCount} symbolic items (${collection.polylineCount} polylines, ${collection.circleCount} circles)`, { operation: 'parseSymbolicRepresentations' });
      return collection;
    } catch (error) {
      log.error('Failed to parse symbolic representations', error, {
        operation: 'parseSymbolicRepresentations',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /**
   * Parse IfcAlignment directrix curves into a flat Float32Array of 3D
   * line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in renderer Y-up world space
   * (RTC-subtracted, metres). Feed straight to `renderer.setLineOverlay('alignment', …)`.
   * Empty when the file has no alignments.
   */
  parseAlignmentLines(content: string, frame?: RtcFrame): Float32Array {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const api = this.ifcApi as IfcAPIWithMerge;
      const vertices = frame === undefined
        ? api.parseAlignmentLines(content)
        : api.parseAlignmentLinesInFrame(content, { ...frame });
      log.debug(`Parsed ${vertices.length / 3} alignment line vertices`, { operation: 'parseAlignmentLines' });
      return vertices;
    } catch (error) {
      log.error('Failed to parse alignment lines', error, {
        operation: 'parseAlignmentLines',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /**
   * Parse `IfcGrid` / `IfcGridAxis` into a flat Float32Array of 3D line-list
   * vertices `[x0,y0,z0, x1,y1,z1, …]` (one segment per axis) in renderer Y-up
   * world space (RTC-subtracted, metres) — the same frame the streamed meshes
   * render in, so grids overlay the model by construction (issue #945). Feed to
   * `setLineOverlay('grid', …)`, NOT `'annotation'` (it expands bounds, #967).
   * Empty when the file has no grids.
   */
  parseGridLines(content: string, frame?: RtcFrame): Float32Array {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const api = this.ifcApi as IfcAPIWithMerge;
      const vertices = frame === undefined
        ? api.parseGridLines(content)
        : api.parseGridLinesInFrame(content, { ...frame });
      log.debug(`Parsed ${vertices.length / 3} grid line vertices`, { operation: 'parseGridLines' });
      return vertices;
    } catch (error) {
      log.error('Failed to parse grid lines', error, {
        operation: 'parseGridLines',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /**
   * Parse `IfcGrid` / `IfcGridAxis` into structured per-axis data
   * (`{ gridId, axisId, tag, start, end }`) in renderer Y-up world space
   * (RTC-subtracted, metres). Use this when you also need the axis tags to
   * render grid bubbles / labels. See issue #945.
   */
  parseGridAxes(content: string, frame?: RtcFrame): GridAxisCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const api = this.ifcApi as IfcAPIWithMerge;
      const collection = frame === undefined
        ? api.parseGridAxes(content)
        : api.parseGridAxesInFrame(content, { ...frame });
      log.debug(`Parsed ${collection.length} grid axes`, { operation: 'parseGridAxes' });
      return collection;
    } catch (error) {
      log.error('Failed to parse grid axes', error, {
        operation: 'parseGridAxes',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /**
   * Extract raw profile polygons from all IfcExtrudedAreaSolid building elements.
   *
   * Returns profile outlines + placement transforms for clean 2D projection
   * without the tessellation artifacts that EdgeExtractor produces.
   *
   * @param content    Raw IFC file text.
   * @param modelIndex Federation model index (use 0 for single-model files).
   */
  extractProfiles(content: string, modelIndex: number = 0): ProfileCollection {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const collection = this.ifcApi.extractProfiles(content, modelIndex);
      log.debug(`Extracted ${collection.length} profiles`, { operation: 'extractProfiles' });
      return collection;
    } catch (error) {
      log.error('Failed to extract profiles', error, {
        operation: 'extractProfiles',
        data: { contentLength: content.length },
      });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /** Exact authored swept-disk definitions and measurements in IFC world metres. */
  extractSweptDiskDescriptions(content: Uint8Array, ids?: Uint32Array): SweptDiskDescriptions {
    return this.runExport('extractSweptDiskDescriptions', content, (api) => api.extractSweptDiskDescriptions(content, ids) as SweptDiskDescriptions);
  }

  /** Exact authored extrusion sources and their world-space product occurrences. */
  extractExtrusionDefinitions(content: Uint8Array, ids?: Uint32Array): ExtrusionDefinitions {
    return this.runExport('extractExtrusionDefinitions', content, (api) => api.extrusionDefinitions(content, ids));
  }

  /**
   * Export the render geometry in `content` as a Wavefront OBJ string.
   * `isolated`: `undefined` ⇒ no filter; empty `Uint32Array` ⇒ active but matching nothing.
   * Throws `NO_RENDER_GEOMETRY` when no mesh is written.
   */
  exportObj(
    content: Uint8Array,
    includeNormals = true,
    hidden: Uint32Array = new Uint32Array(),
    isolated: Uint32Array | undefined = undefined,
  ): Uint8Array {
    return this.runExport('exportObj', content, (api) =>
      api.exportObj(content, includeNormals, hidden, isolated),
    );
  }

  /**
   * Run geometry extraction on the raw IFC `content` (`Uint8Array`) and return ONLY
   * its typed CSG / opening diagnostics (the `GeometryDiagnostics` contract), or
   * `undefined` when nothing diagnostic-worthy happened. The produced meshes are
   * dropped. Takes bytes (not a string) so there is no input-size cap.
   */
  diagnoseGeometry(content: Uint8Array): GeometryDiagnostics | undefined {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      const diag = this.ifcApi.diagnoseGeometry(content) as GeometryDiagnostics | undefined;
      return diag ?? undefined;
    } catch (error) {
      log.error('Failed to diagnose geometry', error, { operation: 'diagnoseGeometry' });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /**
   * Export render geometry as binary glTF (GLB). `emissive` self-illuminates each
   * material (#1427); `nameByGlobalId` names one node per element by GlobalId (#9011,
   * wasm `exportGlbNamedByGlobalId`).
   * `isolated`: `undefined` ⇒ no filter; empty `Uint32Array` ⇒ active but
   * matching nothing, i.e. hide every mesh — don't collapse the two (#4328).
   */
  exportGlb(
    content: Uint8Array,
    includeMetadata = false,
    hidden: Uint32Array = new Uint32Array(),
    isolated: Uint32Array | undefined = undefined,
    hiddenTypesCsv = '',
    lit = true, emissive = false, nameByGlobalId = false,
  ): Uint8Array {
    return this.runExport('exportGlb', content, (api) =>
      (nameByGlobalId ? api.exportGlbNamedByGlobalId : api.exportGlb).call(api, content, includeMetadata, hidden, isolated, hiddenTypesCsv, lit, emissive),
    );
  }

  /**
   * Export tabular CSV. `mode` ∈ {`'entities'`, `'properties'`, `'quantities'`};
   * empty `delimiter` ⇒ `,`; `includeProperties` adds flattened `Pset_Prop` columns.
   */
  exportCsv(
    content: Uint8Array,
    mode: 'entities' | 'properties' | 'quantities' | 'spatial' = 'entities',
    delimiter = ',',
    includeProperties = false,
  ): Uint8Array {
    return this.runExport('exportCsv', content, (api) =>
      api.exportCsv(content, mode, delimiter, includeProperties),
    );
  }

  /** Export structured JSON (array of entity objects with typed property values). */
  exportJson(
    content: Uint8Array,
    pretty = false,
    includeProperties = true,
    includeQuantities = true,
  ): Uint8Array {
    return this.runExport('exportJson', content, (api) =>
      api.exportJson(content, pretty, includeProperties, includeQuantities),
    );
  }

  planSectionExport(content: Uint8Array, planes: string, trim: boolean): string {
    return this.runExport('planSectionExport', content, api => api.planSectionExport(content, planes, trim));
  }
  /** Plan coordinate compatibility patches; all domain math remains in Rust. */
  planMapConversionNormalization(content: Uint8Array): string {
    return this.runExport('planMapConversionNormalization', content, api => api.planMapConversionNormalization(content));
  }

  /**
   * Re-serialize the model in `content` to a STEP/IFC string (P1: base
   * re-serialization + reference-closed subset). Empty `schema` preserves the source;
   * `included` distinguishes no filter (`undefined`) from an active empty filter (#4659).
   */
  exportStep(
    content: Uint8Array,
    schema = '',
    included: Uint32Array | undefined = undefined,
    mutationsJson = '',
  ): Uint8Array {
    return this.runExport('exportStep', content, (api) =>
      api.exportStep(content, schema, included, mutationsJson),
    );
  }

  /** Merge several IFC models into one STEP/IFC string (flat bytes + per-model lengths). */
  exportMerged(concatenated: Uint8Array, lengths: Uint32Array, schema = ''): Uint8Array {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      return this.ifcApi.exportMerged(concatenated, lengths, schema);
    } catch (error) {
      log.error('Failed to exportMerged', error, { operation: 'exportMerged' });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /** Export IFC5/IFCX (USD-style node graph). */
  exportIfcx(content: Uint8Array, onlyKnownProperties = true, pretty = false): Uint8Array {
    return this.runExport('exportIfcx', content, (api) =>
      api.exportIfcx(content, onlyKnownProperties, pretty),
    );
  }

  /** Export OpenUSD (`.usda` ASCII) — a real Z-up USD stage (geometry-backed).
   * Throws `NO_RENDER_GEOMETRY` for a model with no render geometry. */
  exportUsd(content: Uint8Array): Uint8Array {
    return this.runExport('exportUsd', content, (api) => api.exportUsd(content));
  }

  /**
   * Export JSON-LD (`@graph` of `ifc:` nodes). Empty `context` ⇒ buildingSMART IFC4 OWL.
   * `included` distinguishes no filter (`undefined`) from an active empty filter and
   * otherwise applies an express-id allowlist like the OBJ/glTF/STEP exporters (#4659).
   */
  exportJsonld(
    content: Uint8Array,
    context = '',
    includeProperties = true,
    includeQuantities = false,
    pretty = false,
    included: Uint32Array | undefined = undefined,
  ): Uint8Array {
    return this.runExport('exportJsonld', content, (api) =>
      api.exportJsonld(content, context, includeProperties, includeQuantities, pretty, included),
    );
  }

  /**
   * Assemble a GLB from already-produced meshes (flattened parallel arrays) — no
   * re-meshing. Used by the viewer, which already holds the meshes on the GPU.
   *
   * `worldMatrix` is the frame the meshes were baked in (#7734): 16 finite
   * numbers, a column-major 4x4 in IFC Z-up metres with `world = M * baked`
   * (`renderFrameWorldMatrix` in `@ifc-lite/geometry/world-frame`). The GLB root
   * carries it so a georeferenced model exports where the from-bytes export
   * puts it. Omit it for a model that was not shifted.
   */
  exportGlbFromMeshes(
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    vertexCounts: Uint32Array,
    indexCounts: Uint32Array,
    colors: Float32Array,
    origins: Float64Array,
    expressIds: Uint32Array,
    includeMetadata: boolean,
    lit = true,
    emissive = false,
    worldMatrix?: ArrayLike<number>,
  ): Uint8Array {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      return this.ifcApi.exportGlbFromMeshes(
        positions, normals, indices, vertexCounts, indexCounts, colors, origins, expressIds, includeMetadata, lit, emissive,
        worldMatrix ? Float64Array.from(worldMatrix) : undefined,
      );
    } catch (error) {
      log.error('Failed to exportGlbFromMeshes', error, { operation: 'exportGlbFromMeshes' });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /**
   * Demesher: simplify already-produced element meshes (flattened parallel
   * arrays, one record per MeshData entry) at per-element levels 1-5. Returns
   * the wasm `SimplifiedMeshes` result object (render meshes in the boundary
   * Y-up convention + IFC-local file-unit geometry per element).
   */
  simplifyMeshes(
    expressIds: Uint32Array,
    levels: Uint8Array,
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    vertexCounts: Uint32Array,
    indexCounts: Uint32Array,
    origins: Float64Array,
    localToWorld: Float64Array,
    localToWorldPresent: Uint8Array,
    rtcX: number,
    rtcY: number,
    rtcZ: number,
    unitScale: number,
    yUp: boolean,
  ) {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      return this.ifcApi.simplifyMeshes(
        expressIds, levels, positions, normals, indices, vertexCounts, indexCounts,
        origins, localToWorld, localToWorldPresent, rtcX, rtcY, rtcZ, unitScale, yUp,
      );
    } catch (error) {
      log.error('Failed to simplifyMeshes', error, { operation: 'simplifyMeshes' });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /**
   * Build a Google-Earth-ready KMZ directly from already-produced meshes (flattened
   * parallel arrays). The model is embedded as COLLADA (`model.dae`) — the only
   * `<Model>` format Google Earth loads — with emission-lit, double-sided materials
   * (#1427). `xAxisAbscissa`/`xAxisOrdinate` are the `IfcMapConversion` grid-north
   * components (pass `undefined` for heading 0). `altitudeMode` selects the KML
   * vertical placement (`'clampToGround'` default rests on the terrain and ignores
   * `altitude`; `'absolute'` places the origin at `altitude` metres MSL).
   */
  exportKmzFromMeshes(
    positions: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    vertexCounts: Uint32Array,
    indexCounts: Uint32Array,
    colors: Float32Array,
    origins: Float64Array,
    latitude: number,
    longitude: number,
    altitude: number,
    xAxisAbscissa: number | undefined,
    xAxisOrdinate: number | undefined,
    name: string,
    altitudeMode?: KmzAltitudeMode,
  ): Uint8Array {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    try {
      return this.ifcApi.exportKmzFromMeshes(
        positions, normals, indices, vertexCounts, indexCounts, colors, origins,
        latitude, longitude, altitude, xAxisAbscissa, xAxisOrdinate, name, altitudeMode,
      );
    } catch (error) {
      log.error('Failed to exportKmzFromMeshes', error, { operation: 'exportKmzFromMeshes' });
      if (this.isWasmRuntimeError(error)) {
        this.recordWasmRuntimeTrap();
      }
      throw error;
    }
  }

  /** HBJSON (Honeybee) export; see `energy-export-bridge.ts` for the contract. */
  exportHbjson(content: Uint8Array, name: string): Uint8Array {
    return this.runExport('exportHbjson', content, (api) => energyExport.callExportHbjson(api, content, name));
  }

  /** Like {@link exportHbjson}; also returns `HbjsonStats` coverage counts (see `energy-export-bridge.ts`). */
  exportHbjsonWithStats(content: Uint8Array, name: string): { content: Uint8Array; stats: HbjsonStats } {
    return this.runExport('exportHbjsonWithStats', content, (api) =>
      energyExport.callExportHbjsonWithStats(api, content, name),
    );
  }

  /** IFC terrain → LandXML 1.2; see `landxml-terrain-export.ts`. Refusals throw `TERRAIN_REFUSED:`. */
  exportLandXmlTerrain(content: Uint8Array, productIds: Uint32Array, options: LandXmlTerrainExportOptions): LandXmlTerrainExport {
    return this.runExport('exportLandXmlTerrain', content, (api) => callExportLandXmlTerrain(api, content, productIds, options));
  }

  /** DFJSON (Dragonfly) export; see `energy-export-bridge.ts` for the contract. */
  exportDfjson(content: Uint8Array, name: string): string {
    return this.runExport('exportDfjson', content, (api) => energyExport.callExportDfjson(api, content, name));
  }

  /**
   * Shared wrapper for the domain-format exporters: init guard + structured error
   * logging + fatal-wasm-error marking, mirroring the other bridge entry points.
   */
  private runExport<T>(op: string, content: Uint8Array, run: (api: IfcAPI) => T): T {
    return runDomainExport(this.ifcApi, op, content, run, error => {
      if (this.isWasmRuntimeError(error)) this.recordWasmRuntimeTrap();
    });
  }

  /**
   * Get IFC-Lite API instance
   */
  getApi(): IfcAPI {
    if (!this.ifcApi) {
      throw new Error('IFC-Lite not initialized. Call init() first.');
    }
    return this.ifcApi;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.lifetime.state.kind === 'ready';
  }

  /**
   * Get version
   */
  getVersion(): string {
    return this.ifcApi?.version ?? 'unknown';
  }

  /**
   * Enable / disable Revit-style multilayer-wall merging (issue #540).
   * Safe to call before `init()` — the value is cached and re-applied
   * on the freshly-constructed IfcAPI.
   */
  setMergeLayers(enabled: boolean): void {
    this.mergeLayers = enabled;
    if (!this.ifcApi) return; // init() will apply on the new IfcAPI
    this.applyMergeLayers();
  }

  /** Read back the merge-layers flag for UI surfaces. */
  getMergeLayers(): boolean {
    return this.mergeLayers;
  }

  /**
   * Forward the cached `mergeLayers` flag to the underlying IfcAPI.
   * Until the Rust agent regenerates the WASM `.d.ts` to add this
   * method, we route through a narrow typed wrapper so the codebase
   * doesn't need `as any` / `@ts-ignore`. If the method is missing
   * (older WASM build), we log and continue — the safe default.
   */
  private applyMergeLayers(): void {
    if (!this.ifcApi) return;
    const api = this.ifcApi as IfcAPIWithMerge;
    if (typeof api.setMergeLayers !== 'function') {
      log.warn('setMergeLayers not present on WASM API — flag tracked but suppression is a no-op until WASM is rebuilt', {
        operation: 'setMergeLayers',
        data: { requested: this.mergeLayers },
      });
      return;
    }
    api.setMergeLayers(this.mergeLayers);
    log.debug(`mergeLayers=${this.mergeLayers}`, { operation: 'setMergeLayers' });
  }

  /**
   * Enable / disable per-entity geometry fingerprinting (issue #924).
   * Pass a positive tolerance in metres to enable; `null` disables.
   * Safe to call before `init()` — the value is cached and re-applied on
   * the freshly-constructed IfcAPI.
   */
  setComputeGeometryHashes(tolerance: number | null): void {
    this.geometryHashTolerance = tolerance != null && tolerance > 0 ? tolerance : null;
    if (!this.ifcApi) return; // init() will apply on the new IfcAPI
    this.applyComputeGeometryHashes();
  }

  /** Read back the active geometry-hash tolerance (null = disabled). */
  getComputeGeometryHashes(): number | null {
    return this.geometryHashTolerance;
  }

  /**
   * Forward the cached geometry-hash tolerance to the underlying IfcAPI.
   * Guards against an older WASM build that predates the binding (the
   * artifact is rebuilt in CI) so the flag degrades to a no-op rather
   * than throwing — same defensive shape as `applyMergeLayers`.
   */
  private applyComputeGeometryHashes(): void {
    if (!this.ifcApi) return;
    const api = this.ifcApi as IfcAPIWithMerge;
    if (typeof api.setComputeGeometryHashes !== 'function') {
      if (this.geometryHashTolerance != null) {
        log.warn('setComputeGeometryHashes not present on WASM API — geometry diff hashes unavailable until WASM is rebuilt', {
          operation: 'setComputeGeometryHashes',
          data: { requested: this.geometryHashTolerance },
        });
      }
      return;
    }
    api.setComputeGeometryHashes(this.geometryHashTolerance);
    log.debug(`computeGeometryHashes=${this.geometryHashTolerance ?? 'off'}`, {
      operation: 'setComputeGeometryHashes',
    });
  }

  /**
   * Select the tessellation detail level for curved geometry (issue #976).
   * `null` restores the engine default (`'medium'` — output identical to the
   * pre-quality pipeline). Safe to call before `init()` — the value is cached
   * and re-applied on the freshly-constructed IfcAPI. Applies to meshes
   * produced AFTER the call; already-emitted geometry is not regenerated.
   */
  setTessellationQuality(level: TessellationQuality | null): void {
    this.tessellationQuality = level;
    if (!this.ifcApi) return; // init() will apply on the new IfcAPI
    this.applyTessellationQuality();
  }

  /** Read back the active tessellation quality (null = engine default). */
  getTessellationQuality(): TessellationQuality | null {
    return this.tessellationQuality;
  }

  /**
   * Forward the cached tessellation quality to the underlying IfcAPI.
   * Guards against an older WASM build that predates the binding so the
   * level degrades to a no-op (default density) rather than throwing —
   * same defensive shape as `applyMergeLayers`.
   */
  private applyTessellationQuality(): void {
    if (!this.ifcApi) return;
    const api = this.ifcApi as IfcAPIWithMerge;
    if (typeof api.setTessellationQuality !== 'function') {
      if (this.tessellationQuality != null) {
        log.warn('setTessellationQuality not present on WASM API — level ignored until WASM is rebuilt', {
          operation: 'setTessellationQuality',
          data: { requested: this.tessellationQuality },
        });
      }
      return;
    }
    api.setTessellationQuality(this.tessellationQuality);
    log.debug(`tessellationQuality=${this.tessellationQuality ?? 'default'}`, {
      operation: 'setTessellationQuality',
    });
  }

  /**
   * Toggle the tier-independent small-cut skip (issue #1286). Safe to call
   * before `init()` — the value is cached and re-applied on the freshly
   * constructed IfcAPI. Applies to meshes produced AFTER the call.
   */
  /** Skip only relationship-based host cuts (#8875). Applied again after engine recovery. */
  setSkipVoids(on: boolean): void {
    this.skipVoids = on;
    if (this.ifcApi) applySkipVoids(this.ifcApi, on);
  }

  setSkipSmallCuts(on: boolean): void {
    this.skipSmallCuts = on;
    if (!this.ifcApi) return; // init() will apply on the new IfcAPI
    this.applySkipSmallCuts();
  }

  /** Read back the active small-cut skip flag. */
  getSkipSmallCuts(): boolean {
    return this.skipSmallCuts;
  }

  /** Replay small-cut configuration, tolerating older WASM bundles. */
  private applySkipSmallCuts(): void {
    if (!this.ifcApi) return;
    const api = this.ifcApi as IfcAPIWithMerge;
    if (typeof api.setSkipSmallCuts !== 'function') {
      if (this.skipSmallCuts) {
        log.warn('setSkipSmallCuts not present on WASM API — flag ignored until WASM is rebuilt', {
          operation: 'setSkipSmallCuts',
          data: { requested: this.skipSmallCuts },
        });
      }
      return;
    }
    api.setSkipSmallCuts(this.skipSmallCuts);
    log.debug(`skipSmallCuts=${this.skipSmallCuts}`, { operation: 'setSkipSmallCuts' });
  }
}
