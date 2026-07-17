/* tslint:disable */
/* eslint-disable */

export class ClashRunResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly a: Uint32Array;
  readonly b: Uint32Array;
  readonly bounds: Float64Array;
  readonly points: Float64Array;
  readonly status: Uint8Array;
  readonly distance: Float64Array;
}

export class ClashSession {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  /**
   * Ingest N elements from flat arenas.
   *
   * - `positions`: concatenated per-element vertex coords (x,y,z,...)
   * - `pos_ranges`: 2 per element = [float_offset, float_len]
   * - `indices`: concatenated per-element LOCAL (0-based) triangle indices
   * - `idx_ranges`: 2 per element = [idx_offset, idx_len]
   * - `aabbs`: 6 per element = [minx,miny,minz,maxx,maxy,maxz]
   */
  ingest(positions: Float32Array, pos_ranges: Uint32Array, indices: Uint32Array, idx_ranges: Uint32Array, aabbs: Float32Array): void;
  /**
   * Run one rule. `group_a`/`group_b` are GLOBAL element indices; an empty
   * `group_b` means a self-clash within `group_a`. `mode`: 0 = hard,
   * 1 = clearance. Records carry GLOBAL element indices.
   */
  runRule(group_a: Uint32Array, group_b: Uint32Array, mode: number, tolerance: number, clearance: number, report_touch: boolean): ClashRunResult;
}

export class GridAxisCollection {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the axis at `index`. Returns `undefined` for out-of-bounds index.
   */
  getAxis(index: number): GridAxisJs | undefined;
  /**
   * Number of grid axes.
   */
  readonly length: number;
  /**
   * Whether the collection is empty.
   */
  readonly isEmpty: boolean;
}

export class GridAxisJs {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * End endpoint `[x, y, z]` in renderer Y-up world space (metres).
   */
  readonly end: Float32Array;
  /**
   * Axis tag (e.g. `"A"`, `"1"`); empty string when unauthored.
   */
  readonly tag: string;
  /**
   * Start endpoint `[x, y, z]` in renderer Y-up world space (metres).
   */
  readonly start: Float32Array;
  /**
   * Express ID of the `IfcGridAxis`.
   */
  readonly axisId: number;
  /**
   * Express ID of the owning `IfcGrid`.
   */
  readonly gridId: number;
}

export class IfcAPI {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Export the render geometry in `content` as a binary **GLB** (`Uint8Array`).
   *
   * `hidden` / `isolated` are express-id visibility filters; `hidden_types_csv` is a
   * comma-separated list of IFC type names whose class toggle is off (e.g.
   * `"IfcOpeningElement,IfcSpace"`). `include_metadata` attaches counts + per-node
   * `expressId`. Per-mesh RTC origin rides the node translation (precision-safe).
   * `lit` emits standard PBR materials that shade from normals; omitted or
   * `true` ⇒ lit (the default), `false` ⇒ flat `KHR_materials_unlit` (the
   * historical look — #1321). Optional at the boundary so older 5-arg callers
   * keep lit-by-default behaviour.
   * `emissive` self-illuminates each material at its base colour (core glTF
   * `emissiveFactor`) so renderers without ambient/IBL — Google Earth — don't
   * render the model near-black (#1427); omitted or `false` ⇒ off.
   *
   * Fails CLOSED: when the visible mesh set is empty this throws an `Error`
   * whose message starts with `NO_RENDER_GEOMETRY`, instead of returning a
   * structurally valid but empty GLB. #1438 put that guard only in the TS
   * CLI/MCP wrappers; making the boundary itself refuse means SDK/viewer/
   * direct callers inherit it too (the TS guards stay as defense-in-depth).
   */
  exportGlb(content: Uint8Array, include_metadata: boolean, hidden: Uint32Array, isolated: Uint32Array, hidden_types_csv: string, lit?: boolean | null, emissive?: boolean | null): Uint8Array;
  /**
   * Package an already-produced **GLB** + georeference into a **KMZ** (`Uint8Array`)
   * for Google Earth: a ZIP of `doc.kml` (a `<Model>` placed at `latitude`/`longitude`/
   * `altitude`) + `model.glb`. `x_axis_abscissa`/`x_axis_ordinate` are the
   * `IfcMapConversion` grid-north components; pass both as `undefined` for heading 0.
   *
   * `altitude_mode` selects the KML vertical placement: `"clampToGround"`
   * (the default when omitted) rests the model on the terrain, ignoring
   * `altitude`; `"absolute"` places the origin at `altitude` metres MSL.
   * Google Earth's terrain already encodes the site elevation, so clamping
   * keeps a wrong/zero/double-counted OrthogonalHeight from floating the
   * model into the sky (#1427); absolute is offered for models whose
   * OrthogonalHeight is a true MSL elevation the user wants honoured.
   */
  exportKmz(glb: Uint8Array, latitude: number, longitude: number, altitude: number, x_axis_abscissa: number | null | undefined, x_axis_ordinate: number | null | undefined, name: string, altitude_mode?: string | null): Uint8Array;
  /**
   * Assemble a **GLB** from already-produced meshes (the viewer's `MeshData`, flattened)
   * — no re-meshing. Per mesh `i`: `vertex_counts[i]` verts + `index_counts[i]` indices
   * taken in order from the concatenated `positions`/`normals`/`indices`; `colors` is
   * RGBA per mesh, `origins` xyz per mesh, `express_ids` labels each mesh (indices are
   * per-mesh local). The caller passes exactly the meshes it wants emitted.
   */
  exportGlbFromMeshes(positions: Float32Array, normals: Float32Array, indices: Uint32Array, vertex_counts: Uint32Array, index_counts: Uint32Array, colors: Float32Array, origins: Float64Array, express_ids: Uint32Array, include_metadata: boolean, lit?: boolean | null, emissive?: boolean | null): Uint8Array;
  /**
   * Build a Google-Earth-ready **KMZ** (`Uint8Array`) straight from the viewer's
   * already-produced meshes — the working path (#1427). The model is embedded as
   * **COLLADA** (`model.dae`), the only `<Model>` format Google Earth loads (a GLB
   * raises "Unsupported element: Model"), with emission-lit double-sided materials
   * placement. Mesh arrays match `exportGlbFromMeshes`;
   * `latitude`/`longitude`/`altitude` + `x_axis_abscissa`/`x_axis_ordinate`
   * (grid-north, `undefined` ⇒ heading 0) place + orient the model.
   * `altitude_mode` (`"clampToGround"` default ⇒ rest on terrain, ignoring
   * `altitude`; `"absolute"` ⇒ place at `altitude` metres MSL) selects the
   * KML vertical placement (#1427).
   */
  exportKmzFromMeshes(positions: Float32Array, normals: Float32Array, indices: Uint32Array, vertex_counts: Uint32Array, index_counts: Uint32Array, colors: Float32Array, origins: Float64Array, latitude: number, longitude: number, altitude: number, x_axis_abscissa: number | null | undefined, x_axis_ordinate: number | null | undefined, name: string, altitude_mode?: string | null): Uint8Array;
  /**
   * Export the render geometry in `content` as Wavefront **OBJ** UTF-8 bytes.
   *
   * Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
   * V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
   * is genuinely needed.
   *
   * `hidden` / `isolated` are express-id filters mirroring the viewer's visibility
   * state (empty `isolated` ⇒ all visible). Instanced type-library shapes are skipped.
   *
   * ```javascript
   * const obj = api.exportObj(ifcContent, true, new Uint32Array(), new Uint32Array());
   * ```
   */
  exportObj(content: Uint8Array, include_normals: boolean, hidden: Uint32Array, isolated: Uint32Array): Uint8Array;
  /**
   * Sharded pre-pass: merge the shard-resolved styled-item columns with the
   * SUPPORT spans (extracted host-side from the shard classes) and run the
   * CANONICAL styles flatten. Returns the exact `styles` event payload the
   * serial path emits. Runs on any worker with `setEntityIndex` installed.
   * Span arguments are `[id, start, len]` triples; `plane_angle_to_radians`
   * comes from the meta event.
   */
  finalizePrepassStyles(data: Uint8Array, orphan_ids: Uint32Array, orphan_colors: Float32Array, geom_ids: Uint32Array, geom_colors: Float32Array, colour_map_spans: Uint32Array, material_def_spans: Uint32Array, rel_material_spans: Uint32Array, void_spans: Uint32Array, fills_spans: Uint32Array, aggregate_spans: Uint32Array, plane_angle_to_radians: number): any;
  /**
   * SPIKE (sharded pre-pass): scan the entity index over a single byte range.
   *
   * Each idle browser geometry worker calls this on its `[range_start,
   * range_end)` shard; the main thread stitches the returned columns into the
   * full entity index (byte-identical to the single-threaded
   * `build_entity_index`) by binary-searching each shard for the previous
   * shard's `handoff`. Delegates to `ifc_lite_processing::scan_shard`, the
   * exact per-chunk primitive the native `build_entity_index_parallel` fans
   * across cores — so the sharded merge cannot drift from the serial builder.
   *
   * Byte offsets returned are GLOBAL (relative to file start), so shards
   * concatenate without rewriting. Returns a plain object:
   *   `{ ids: Uint32Array, starts: Uint32Array, lengths: Uint32Array,
   *      handoff: number }`
   * where `handoff` is the global start of the first entity at/after
   * `range_end` (the next shard's first real entity), or `-1` at EOF.
   */
  scanEntityIndexShard(data: Uint8Array, range_start: number, range_end: number): any;
  /**
   * Sharded pre-pass: resolve ONE contiguous (file-ordered) slice of the
   * styled-item span list on this worker, against the entity index installed
   * by `setEntityIndex`. Returns raw resolved maps as flat columns:
   * `{ orphanIds, orphanColors (f32 rgba per id), geomIds, geomColors }`.
   * The host merges shard results IN SHARD ORDER with first-wins per
   * geometry id, reproducing the serial resolver's file-order precedence,
   * then hands the merged columns to `finalizePrepassStyles`.
   * `spans` is `[id, start, len]` triples.
   */
  resolveStyledItemsShard(data: Uint8Array, spans: Uint32Array): any;
  /**
   * Sharded pre-pass variant: same scan/discovery/jobs/columns pipeline as
   * `buildPrePassStreaming`, but
   *  1. the entity index is PREBUILT from the host's stitched shard columns
   *     (file order; see `scanEntityIndexShard`) — the scan skips its inline
   *     index build, the meta RTC ladder resolves against the FULL index
   *     (no partial-ladder full-rescan detour), and the post-scan
   *     `entity-index` event is skipped (the host already delivered it), and
   *  2. styles resolution is EXTERNAL: the styled-item spans are resolved as
   *     shard slices on the geometry workers (`resolveStyledItemsShard`);
   *     this call stashes the SUPPORT spans + plane-angle scale, and the
   *     follow-up `finalizePrepassStyles` merges + flattens into the exact
   *     styles payload the serial path emits. NO `styles` event is emitted
   *     here.
   */
  buildPrePassStreamingSharded(data: Uint8Array, on_event: Function, chunk_size: number, disabled_type_names: string[] | null | undefined, skip_type_geometry: boolean, index_ids: Uint32Array, index_starts: Uint32Array, index_lengths: Uint32Array, index_classes: Uint8Array): any;
  /**
   * Store the whole IFC source file ONCE per load so the `*FromSource` batch
   * variants can read it from the wasm heap instead of re-copying it per call.
   *
   * Mirrors the `setEntityIndex` lifecycle: called once per worker per load,
   * and REPLACES the previous file wholesale (repeated calls swap the bytes),
   * so a parser/geometry worker reusing one `IfcAPI` across loads is safe.
   * The bytes must be the exact source the batch jobs' byte spans index into
   * (the same buffer passed as `data` to the legacy `processGeometryBatch*`),
   * or the decoded entities won't match — the JS worker installs its own
   * session buffer, so this holds by construction.
   *
   * Taking `Vec<u8>` (by value) means wasm-bindgen hands us ownership of the
   * single JS→wasm copy directly; we wrap it in `Arc` with no second copy.
   */
  setSourceBytes(data: Uint8Array): void;
  /**
   * Like [`IfcAPI::process_geometry_batch`] but reads the source bytes held by
   * [`IfcAPI::set_source_bytes`] instead of taking `data`. Byte-for-byte
   * identical output — it delegates to the legacy twin with the held slice.
   */
  processGeometryBatchFromSource(jobs_flat: Uint32Array, unit_scale: number, rtc_x: number, rtc_y: number, rtc_z: number, needs_shift: boolean, void_keys: Uint32Array, void_counts: Uint32Array, void_values: Uint32Array, style_ids: Uint32Array, style_colors: Uint8Array, plane_angle_to_radians?: number | null, material_element_ids?: Uint32Array | null, material_color_counts?: Uint32Array | null, material_colors_rgba?: Uint8Array | null): MeshCollection;
  /**
   * Like [`IfcAPI::process_geometry_batch_partitioned`] but reads the source
   * bytes held by [`IfcAPI::set_source_bytes`] instead of taking `data`.
   * Byte-for-byte identical output — it delegates to the legacy twin.
   */
  processGeometryBatchPartitionedFromSource(jobs_flat: Uint32Array, unit_scale: number, rtc_x: number, rtc_y: number, rtc_z: number, needs_shift: boolean, void_keys: Uint32Array, void_counts: Uint32Array, void_values: Uint32Array, style_ids: Uint32Array, style_colors: Uint8Array, plane_angle_to_radians?: number | null, material_element_ids?: Uint32Array | null, material_color_counts?: Uint32Array | null, material_colors_rgba?: Uint8Array | null): PartitionedBatch;
  /**
   * Process geometry for a subset of pre-scanned entities → flat
   * MeshCollection. Takes raw bytes + pre-pass data from buildPrePassOnce.
   * Thin wrapper over [`IfcAPI::produce_batch`]; converts each produced mesh
   * to MeshDataJs (the IFC Z-up→WebGL Y-up swap + winding reversal happen
   * there). Output is byte-for-byte what the pre-refactor method produced.
   */
  processGeometryBatch(data: Uint8Array, jobs_flat: Uint32Array, unit_scale: number, rtc_x: number, rtc_y: number, rtc_z: number, needs_shift: boolean, void_keys: Uint32Array, void_counts: Uint32Array, void_values: Uint32Array, style_ids: Uint32Array, style_colors: Uint8Array, plane_angle_to_radians?: number | null, material_element_ids?: Uint32Array | null, material_color_counts?: Uint32Array | null, material_colors_rgba?: Uint8Array | null): MeshCollection;
  /**
   * Like [`IfcAPI::process_geometry_batch`] but collates the batch's meshes
   * into a GPU-instancing shard (IFNS wire format) instead of a flat
   * MeshCollection. Repeated geometry collapses to one template + per-
   * occurrence transforms; non-instanceable meshes ride as flat singleton
   * templates so nothing is dropped. The shard stays in the producer-native
   * (IFC Z-up) frame — the renderer composes the constant Z-up→Y-up swap at
   * upload. Each batch shard renders independently: affinity routing already
   * co-locates identical geometry on one worker, so per-batch collation
   * captures ~all the dedup and no cross-batch merge is needed. Returns empty
   * bytes only when the batch produced zero non-empty meshes.
   */
  processGeometryBatchInstanced(data: Uint8Array, jobs_flat: Uint32Array, unit_scale: number, rtc_x: number, rtc_y: number, rtc_z: number, needs_shift: boolean, void_keys: Uint32Array, void_counts: Uint32Array, void_values: Uint32Array, style_ids: Uint32Array, style_colors: Uint8Array, plane_angle_to_radians?: number | null, material_element_ids?: Uint32Array | null, material_color_counts?: Uint32Array | null, material_colors_rgba?: Uint8Array | null): Uint8Array;
  /**
   * Produce a batch ONCE and PARTITION it (the instanced-ONLY path): opaque
   * ordinary occurrences (colour alpha >= 0.99 AND geometry_class == 0) are
   * collated into the instanced shard; everything else (transparent glass,
   * type-product geometry) goes to the flat MeshCollection. Each mesh takes
   * exactly ONE route, so produce_batch runs once (no emit-both 2× meshing)
   * and the renderer draws opaque occurrences via instancing instead of flat.
   * Partition mirrors the renderer gates: INSTANCED_ALPHA_CUTOFF (0.99 =
   * OPAQUE_ALPHA_CUTOFF) for transparency, geometry_class for the Model/Types
   * split.
   *
   * NOTE: the renderer must be instanced-feature-complete (picking / selection
   * / lens overlays on instanced geometry) before the worker calls this in
   * place of processGeometryBatch — otherwise those features break for the
   * opaque bulk. See the instanced-only follow-ups.
   */
  processGeometryBatchPartitioned(data: Uint8Array, jobs_flat: Uint32Array, unit_scale: number, rtc_x: number, rtc_y: number, rtc_z: number, needs_shift: boolean, void_keys: Uint32Array, void_counts: Uint32Array, void_values: Uint32Array, style_ids: Uint32Array, style_colors: Uint8Array, plane_angle_to_radians?: number | null, material_element_ids?: Uint32Array | null, material_color_counts?: Uint32Array | null, material_colors_rgba?: Uint8Array | null): PartitionedBatch;
  /**
   * Run the pre-pass ONCE and return serialized results for worker distribution.
   * Takes raw bytes (&[u8]) to avoid TextDecoder overhead.
   */
  buildPrePassOnce(data: Uint8Array): any;
  /**
   * Streaming pre-pass: emits geometry jobs in chunks via a JS callback
   * instead of waiting for the full file scan to complete.
   *
   * Single linear walk over the file:
   *   1. Builds the entity index incrementally from the same scan that
   *      collects geometry jobs (a separate index scan would double
   *      wall-clock).
   *   2. As soon as `IFCPROJECT` has been seen, the unit scale and the
   *      first ~50 geometry jobs have been collected, resolves
   *      `unitScale` + `rtcOffset` and emits a `meta` callback so the
   *      JS host can spin up geometry process workers.
   *   3. Emits `jobs` callbacks every `chunk_size` jobs (or fewer if
   *      the meta phase already buffered some).
   *   4. Emits `complete` with the total job count at end of scan.
   *
   * On a 986 MB / 14 M-entity file this drops time-to-first-geometry
   * from ~17 s (full pre-pass + worker spawn + first batch) to ~3 s
   * (first 100 K bytes scanned + meta + first chunk).
   *
   * The callback receives a single `JsValue` argument shaped as one of:
   *   `{ type: "meta", unitScale, rtcOffset: [x,y,z], needsShift, buildingRotation? }`
   *   `{ type: "jobs", jobs: Uint32Array }`     // [id, start, end] triples
   *   `{ type: "complete", totalJobs }`
   */
  buildPrePassStreaming(data: Uint8Array, on_event: Function, chunk_size: number, disabled_type_names: string[] | null | undefined, skip_type_geometry: boolean): any;
  /**
   * Parse the file and return structured per-axis data (tag + endpoints) in
   * the renderer's Y-up world space (RTC-subtracted, metres). Use this when
   * you also need the axis tags (to render grid bubbles / labels).
   */
  parseGridAxes(content: string): GridAxisCollection;
  /**
   * Parse the file and return every `IfcGridAxis` as a flat `Float32Array`
   * of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` (one segment per
   * axis) in the renderer's Y-up world space (RTC-subtracted, metres). Feed
   * straight to a line pipeline (e.g. `uploadAnnotationLines3D`).
   *
   * Returns an empty array when the file has no grids, so the caller can
   * clear the overlay cheaply.
   */
  parseGridLines(content: string): Float32Array;
  /**
   * Export tabular **CSV**. `mode` ∈ {`"entities"`, `"properties"`, `"quantities"`,
   * `"spatial"`}. `delimiter` defaults to `,` when empty; `include_properties` adds
   * flattened `Pset_Prop` columns to the entities view.
   */
  exportCsv(content: Uint8Array, mode: string, delimiter: string, include_properties: boolean): Uint8Array;
  /**
   * Export **IFC5 / IFCX** (the USD-style node graph). `only_known_properties` keeps
   * only properties with an official IFC5 schema.
   */
  exportIfcx(content: Uint8Array, only_known_properties: boolean, pretty: boolean): Uint8Array;
  /**
   * Export structured **JSON** (array of entity objects with typed property values).
   */
  exportJson(content: Uint8Array, pretty: boolean, include_properties: boolean, include_quantities: boolean): Uint8Array;
  /**
   * Export **JSON-LD** (`@graph` of `ifc:` nodes). Empty `context` ⇒ buildingSMART
   * IFC4 OWL default. `included` is an express-id isolation filter mirroring the
   * OBJ/glTF/STEP exporters (empty ⇒ all entities).
   */
  exportJsonld(content: Uint8Array, context: string, include_properties: boolean, include_quantities: boolean, pretty: boolean, included: Uint32Array): Uint8Array;
  /**
   * Re-serialize the model in `content` to STEP/IFC UTF-8 bytes.
   *
   * Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
   * V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
   * is genuinely needed.
   *
   * `schema` is the FILE_SCHEMA label to write (empty ⇒ preserve the source schema).
   * `included` is an express-id allowlist (empty ⇒ whole model); when set, the forward
   * `#`-reference closure is added so the subset never dangles a reference.
   * `mutations_json` carries `MutablePropertyView` edits (attribute updates +
   * property-set synthesis); empty ⇒ none. See `export_step_json` for the shape.
   */
  exportStep(content: Uint8Array, schema: string, included: Uint32Array, mutations_json: string): Uint8Array;
  /**
   * Merge several IFC models into one STEP/IFC UTF-8 byte buffer (`Uint8Array`).
   * `concatenated` is every model's
   * bytes laid end-to-end; `lengths[i]` is the byte length of model `i`. The first model
   * keeps its ids; later models are id-offset and their project unified to the first.
   */
  exportMerged(concatenated: Uint8Array, lengths: Uint32Array, schema: string): Uint8Array;
  /**
   * Export the `IfcSpace` volumes in `content` as Honeybee **HBJSON** UTF-8 bytes.
   *
   * Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
   * V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
   * is genuinely needed.
   *
   * Rooms are built analytically from extruded-area profiles (watertight by construction);
   * faces are typed Floor / RoofCeiling / Wall with outward normals. The result loads via
   * `honeybee.model.Model.from_hbjson` and is ready for Ladybug Tools / Pollination.
   *
   * ```javascript
   * const api = new IfcAPI();
   * const hbjson = api.exportHbjson(ifcContent, "my_model");
   * ```
   */
  exportHbjson(content: Uint8Array, name: string): Uint8Array;
  /**
   * Parse the file and return every `IfcAlignment` directrix as a flat
   * `Float32Array` of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in
   * the renderer's Y-up world space (RTC-subtracted, metres). Consecutive
   * samples form line segments. Feed straight to
   * `renderer.uploadAnnotationLines3D(...)`.
   *
   * Returns an empty array when the file has no alignments (or none with a
   * resolvable Axis curve), so the caller can clear the overlay cheaply.
   */
  parseAlignmentLines(content: string): Float32Array;
  /**
   * Extract raw profile polygons from all building elements with `IfcExtrudedAreaSolid`
   * representations.
   *
   * Returns a [`ProfileCollection`] whose entries each carry:
   * - A 2D polygon (outer + holes) in local profile space (metres)
   * - A 4 × 4 column-major transform in WebGL Y-up world space
   * - Extrusion direction (world space) and depth (metres)
   *
   * Use [`ProfileProjector`] (TypeScript) to convert these into `DrawingLine[]`
   * for clean projection without tessellation artifacts.
   *
   * ```javascript
   * const api = new IfcAPI();
   * const profiles = api.extractProfiles(ifcContent, 0);
   * console.log('Profiles:', profiles.length);
   * for (let i = 0; i < profiles.length; i++) {
   *   const p = profiles.get(i);
   *   console.log(p.ifcType, 'depth:', p.extrusionDepth);
   * }
   * ```
   */
  extractProfiles(content: string, model_index: number): ProfileCollection;
  /**
   * Structured pipeline diagnostics accumulated across every
   * `processGeometryBatch*` call since the last load reset
   * (`clearPrePassCache` / `setEntityIndex`), as a JS object with a
   * `schemaVersion` field — or `undefined` when no batch has run yet.
   * Includes per-batch summed geometry wall time, mesh/triangle counts,
   * the degenerate-backstop drop count, and the CSG failure aggregates.
   */
  getPipelineDiagnostics(): any;
  /**
   * Get WASM memory for zero-copy access
   */
  getMemory(): any;
  /**
   * Populate `cached_entity_index` from pre-extracted column arrays.
   *
   * Used by the streaming pre-pass to share its already-built entity
   * index across worker realms via SAB-backed Uint32Arrays — every
   * process worker would otherwise re-scan the entire file in
   * `processGeometryBatch`'s lazy build path (~5 s on a 1 GB IFC),
   * even though the pre-pass worker built the same index minutes
   * earlier.
   *
   * Builds a compact [`ColumnarEntityIndex`] from the three input slices
   * (sorted `u32` columns + binary search) instead of a per-worker
   * `FxHashMap` — ~229 MB vs ~436 MB on a 19.1 M-entity model (#1682).
   * [`ColumnarEntityIndex::from_columns`] verifies the id ordering once
   * (O(n)) and only argsorts if the producer did not emit sorted columns.
   *
   * `lengths[i]` is the byte length of entity `ids[i]`, so lookup returns
   * `(start, start + length)` to match the existing `(start, end)` layout.
   *
   * Idempotent in the sense that repeated calls REPLACE the cache —
   * supports the parser-worker pattern of reusing one IfcAPI across
   * multiple loads with different files.
   */
  setEntityIndex(ids: Uint32Array, starts: Uint32Array, lengths: Uint32Array): void;
  /**
   * Toggle the "render multilayer walls as a single solid" mode (issue #540).
   *
   * When `enabled` is `true`, every subsequent `processGeometryBatch` call
   * will suppress geometry emission for `IfcBuildingElementPart` entities
   * whose `IfcRelAggregates` parent wall is sliceable (has an
   * `IfcMaterialLayerSetUsage`) AND has its own `Representation`. The
   * parent wall keeps its per-layer sub-mesh colouring, so the visual
   * result is the same as the layered render but with one mesh per wall
   * instead of one per layer part — much cheaper for both CPU and GPU.
   *
   * Default is `false`. Pass `true` before calling `processGeometryBatch`.
   */
  setMergeLayers(enabled: boolean): void;
  /**
   * Toggle the tier-independent small-cut skip (#1286). When `true`,
   * `processGeometryBatch` drops `IfcBooleanResult` differences whose cutter is
   * tiny relative to its host (steel copes/notches) while keeping the
   * tessellation tier — so curves stay full-density. The viewer enables this for
   * the on-screen load; exports/drawings leave it off so their geometry keeps
   * every cut. Default off ⇒ byte-identical to before.
   *
   * Set BEFORE processing — meshes already emitted are not regenerated.
   */
  setSkipSmallCuts(on: boolean): void;
  /**
   * Clear the cached entity index (call between loads when reusing
   * the same `IfcAPI` instance — e.g. the parser worker keeps one
   * `IfcAPI` alive across multiple `parse` requests).
   *
   * Recovers a poisoned cache Mutex instead of panicking; see `mod_tests.rs`.
   */
  clearPrePassCache(): void;
  /**
   * Install the pre-computed set of `IfcRepresentationMap` ids referenced by
   * an `IfcMappedItem` (issue #957), so the worker's first type-product batch
   * SKIPS the per-worker [`Self::get_or_build_referenced_repmaps`] full-file
   * walk. The streaming pre-pass built the same set once from the
   * `IfcMappedItem` spans it already scanned (see
   * `styling::build_referenced_representation_maps_from_spans`) and ships the
   * id list here — bit-identical to what each worker would compute, since a
   * set's membership is order-invariant and consumers only call `.contains`.
   *
   * Installed AFTER `setEntityIndex` (which clears this cache on content
   * swap), so the injected value survives. When this setter is never called
   * (native path, non-streaming callers), the lazy build path is unchanged.
   */
  setReferencedRepmaps(ids: Uint32Array): void;
  /**
   * Install the pre-computed #1623 Phase 3 don't-bake plan: the flat list of
   * `IfcRepresentationMap` ids that an `IfcMappedItem` instantiates >= 2 times.
   * The streaming pre-pass tallies it in the SAME scan that builds the referenced-
   * repmap set (`styling::build_mapped_instance_plan_from_spans`) and ships the id
   * list here. The batch path arms its router with it (batch-local template mode),
   * so a repeated single-solid mapped source materializes ONCE per batch and the
   * rest ride as instances in the IFNS shard.
   *
   * Same injection contract as [`Self::set_referenced_repmaps`]: installed after
   * `setEntityIndex` (which clears it on content swap), and a no-op absence leaves
   * the batch path materializing every occurrence (byte-identical). Each id is
   * stored as `(2, id)` — the batch-local router only needs the eligibility set
   * (count >= 2); the min-id template slot is unused in batch-local mode.
   */
  setMappedInstancePlan(source_ids: Uint32Array): void;
  /**
   * Install the pre-computed [`ifc_lite_geometry::MaterialLayerIndex`] (#563)
   * from its flat SoA encoding, so the worker's first batch skips the
   * per-worker [`Self::get_or_build_material_layer_index`] full-file decode
   * scan (the dominant first-batch cost on layered architectural models,
   * which run this on the DEFAULT view). The streaming pre-pass built the
   * index once from the `IfcRelAssociatesMaterial` spans it already scanned
   * (`MaterialLayerIndex::from_spans`) and flat-encoded it here; the flat
   * encoding round-trips bit-for-bit (proven in `material_layer_index` tests),
   * so the injected index equals each worker's `from_content` result.
   *
   * Same injection contract as [`Self::set_referenced_repmaps`]: installed
   * after `setEntityIndex`, and a no-op absence leaves the lazy build intact.
   */
  setMaterialLayerIndex(element_ids: Uint32Array, axis: Uint32Array, layer_counts: Uint32Array, direction_sense: Float64Array, offset: Float64Array, layer_material_ids: Uint32Array, layer_thicknesses: Float64Array): void;
  /**
   * Enable or disable the PARAMETRIC rectangular-opening fast path (the
   * placement-frame, ground-truth-exact analytic cut) for `processGeometryBatch`.
   *
   * DEFAULT ON (corpus-validated; native defaults ON too, and wasm has no env to
   * read `IFC_LITE_RECT_PARAM`, so both targets default in LOCKSTEP -- the
   * byte-identical native==wasm contract requires both take the same path). This
   * toggle is the wasm-side escape hatch mirroring `IFC_LITE_RECT_PARAM=0`.
   * The path subtracts rectangular openings as exact parametric boxes in the host's
   * own placement frame (rotated walls included), deferring any non-clean case to
   * the exact kernel. Pass `false` before `processGeometryBatch` to opt out.
   */
  setRectParamFastPath(enabled: boolean): void;
  /**
   * Select the tessellation detail level applied by every subsequent
   * `processGeometryBatch` call (issue #976, step 4).
   *
   * `level` is one of `"lowest" | "low" | "medium" | "high" | "highest"`
   * (case-insensitive). `"medium"` is the default and reproduces the
   * engine's historical hardcoded densities byte-for-byte; lower levels
   * trade curved-surface smoothness for throughput, higher levels reduce
   * faceting on pipes / cylinders / NURBS at a triangle-count cost.
   * Pass `null`/`undefined` to reset to the default.
   *
   * Set BEFORE processing — meshes already emitted are not regenerated.
   * Throws on an unrecognized level so typos fail loudly instead of
   * silently rendering at the wrong density.
   */
  setTessellationQuality(level?: string | null): void;
  /**
   * Install the pre-computed set of type ids that an `IfcRelDefinesByType`
   * instantiates (#957 follow-up), so the worker's first type-product batch
   * skips the per-worker [`Self::get_or_build_instantiated_type_ids`]
   * full-file walk. Same injection contract as [`Self::set_referenced_repmaps`].
   */
  setInstantiatedTypeIds(ids: Uint32Array): void;
  /**
   * Enable or disable per-entity geometry fingerprinting in
   * `processGeometryBatch`, used by the viewer's revision-diff feature.
   *
   * Pass a positive `tolerance` (metres) to enable — it is the quantization
   * grid the hash snaps positions to (larger = more tolerant of float noise,
   * smaller = catches finer edits; the `f32` precision floor of model-local
   * coordinates means values below ~1 mm mostly hash noise). Pass `null`/
   * `undefined` (or a non-positive value) to disable. Default: disabled.
   */
  setComputeGeometryHashes(tolerance?: number | null): void;
  /**
   * Create and initialize the IFC API
   */
  constructor();
  /**
   * Fast entity scanning using SIMD-accelerated Rust scanner
   * Returns array of entity references for data model parsing
   * Much faster than TypeScript byte-by-byte scanning (5-10x speedup)
   */
  scanEntitiesFast(content: string): any;
  /**
   * Fast entity scanning from raw bytes (avoids TextDecoder.decode on JS side).
   * Accepts Uint8Array directly — saves ~2-5s for 487MB files by skipping
   * JS string creation and UTF-16→UTF-8 conversion.
   */
  scanEntitiesFastBytes(data: Uint8Array): any;
  /**
   * Fast geometry-only entity scanning
   * Scans only entities that have geometry, skipping 99% of non-geometry entities
   * Returns array of geometry entity references for parallel processing
   * Much faster than scanning all entities (3x speedup for large files)
   */
  scanGeometryEntitiesFast(content: string): any;
  /**
   * Run geometry extraction on `content` and return its typed CSG / opening
   * diagnostics (the `GeometryDiagnostics` contract) as a JS object, or
   * `undefined` when nothing diagnostic-worthy happened (no openings, no
   * failures). Takes the raw IFC bytes (`Uint8Array`) so there is no input-size
   * cap. The produced meshes are dropped; only the diagnostics are returned.
   */
  diagnoseGeometry(content: Uint8Array): any;
  /**
   * Simplify already-produced element meshes at per-element demesher
   * levels (1-4 = cavity removal + clustering at 0.5/0.25/0.10/0.03
   * triangle ratio, 5 = bounding box).
   *
   * One RECORD per input `MeshData` entry (an element may span several
   * records — per-material submeshes; pass all of them, grouped or not).
   * Per record `i`: `vertexCounts[i]` vertices from `positions` (and
   * `normals` when non-empty), `indexCounts[i]` indices from `indices`
   * (per-record local), `origins[i*3..]`, `localToWorld[i*16..]` valid
   * only when `localToWorldPresent[i] != 0`, level `levels[i]` (records
   * of one element must agree). Arrays are the boundary Y-up convention
   * when `yUp` is true (the browser/SDK case).
   *
   * `rtcX/Y/Z` = `coordinateInfo.originShift` (IFC Z-up metres);
   * `unitScale` = metres per project length unit.
   */
  simplifyMeshes(express_ids: Uint32Array, levels: Uint8Array, positions: Float32Array, normals: Float32Array, indices: Uint32Array, vertex_counts: Uint32Array, index_counts: Uint32Array, origins: Float64Array, local_to_world: Float64Array, local_to_world_present: Uint8Array, rtc_x: number, rtc_y: number, rtc_z: number, unit_scale: number, y_up: boolean): SimplifiedMeshes;
  /**
   * Parse IFC file and extract symbolic representations (Plan,
   * Annotation, FootPrint, Axis). These are 2D curves used for
   * architectural drawings instead of sectioning 3D geometry.
   *
   * Example:
   * ```javascript
   * const api = new IfcAPI();
   * const symbols = api.parseSymbolicRepresentations(ifcData);
   * console.log('Found', symbols.totalCount, 'symbolic items');
   * for (let i = 0; i < symbols.polylineCount; i++) {
   *   const polyline = symbols.getPolyline(i);
   *   console.log('Polyline for', polyline.ifcType, ':', polyline.points);
   * }
   * ```
   */
  parseSymbolicRepresentations(content: string): SymbolicRepresentationCollection;
  /**
   * Get version string
   */
  readonly version: string;
  /**
   * Check if API is initialized
   */
  readonly is_ready: boolean;
}

export class MeshCollection {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Check if RTC offset is significant (>10km)
   */
  hasRtcOffset(): boolean;
  /**
   * Get mesh at index (clones — non-destructive). Prefer `takeMesh` on the
   * hot streaming path; this stays for callers that read meshes more than once.
   */
  get(index: number): MeshDataJs | undefined;
  /**
   * #1097 perf: MOVE the mesh at `index` out of the collection (the Vec
   * buffers are `std::mem::take`-n, leaving an empty stub). The streaming
   * worker reads each mesh exactly once, so moving avoids the full vertex-
   * data clone `get` pays — one fewer copy of positions/normals/indices/uvs/
   * texture per mesh (the JS getters still do the single Rust→JS copy). Calling
   * it twice for the same index yields the second call an empty mesh.
   */
  takeMesh(index: number): MeshDataJs | undefined;
  /**
   * The batch's typed CSG / opening diagnostics as a JS object (the
   * `GeometryDiagnostics` contract), or `undefined` if none were recorded. The
   * worker merges these across batches. One serialized value keeps the rich
   * nested shape as a single FFI crossing instead of dozens of getters.
   */
  readonly diagnostics: any;
  /**
   * Get RTC offset X (for converting local coords back to world coords)
   * Add this to local X coordinates to get world X coordinates
   */
  readonly rtcOffsetX: number;
  /**
   * Get RTC offset Y
   */
  readonly rtcOffsetY: number;
  /**
   * Get RTC offset Z
   */
  readonly rtcOffsetZ: number;
  /**
   * Get total vertex count across all meshes
   */
  readonly totalVertices: number;
  /**
   * Get total triangle count across all meshes
   */
  readonly totalTriangles: number;
  /**
   * Get building rotation angle in radians (from IfcSite placement)
   * Returns None if no rotation was detected
   */
  readonly buildingRotation: number | undefined;
  /**
   * Express ids for the per-entity geometry fingerprints, parallel to
   * [`Self::geometry_hash_values`]. Empty unless geometry hashing was
   * enabled via `IfcAPI.setComputeGeometryHashes`.
   */
  readonly geometryHashIds: Uint32Array;
  /**
   * Number of per-entity geometry fingerprints recorded.
   */
  readonly geometryHashCount: number;
  /**
   * Per-entity geometry fingerprints as a `BigUint64Array`, parallel to
   * [`Self::geometry_hash_ids`]. `u64` is exposed (not hex strings) so JS
   * can compare with `===` and key maps without allocation. Empty unless
   * geometry hashing was enabled.
   */
  readonly geometryHashValues: BigUint64Array;
  /**
   * Get number of meshes
   */
  readonly length: number;
}

export class MeshDataJs {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get express ID
   */
  readonly expressId: number;
  /**
   * True when this mesh carries a surface texture (#961).
   */
  readonly hasTexture: boolean;
  /**
   * Local (pre-placement, object-space) AABB (issue #1474), WebGL Y-up,
   * `[minX,minY,minZ,maxX,maxY,maxZ]`. `undefined` when not captured
   * (wasm-bindgen maps `Option::None` to `undefined`, not `null`).
   */
  readonly localBounds: Float32Array | undefined;
  /**
   * Decoded RGBA8 texture bytes (`width*height*4`). Empty when untextured.
   */
  readonly textureRgba: Uint8Array;
  /**
   * Get vertex count
   */
  readonly vertexCount: number;
  /**
   * Optional SurfaceColour for the "Shading" GLB-export choice — only
   * present when the file authored a distinct DiffuseColour. JS sees
   * `undefined` when absent (most files).
   */
  readonly shadingColor: Float32Array | undefined;
  readonly textureWidth: number;
  /**
   * Geometry provenance for the viewer's Model/Types switch (#957 follow-up):
   * 0 = occurrence, 1 = orphan type geometry (no occurrence), 2 = instanced
   * type geometry (hidden in Model mode, shown in Types mode).
   */
  readonly geometryClass: number;
  /**
   * The resolved `IfcLocalPlacement` chain for this mesh (issue #1474),
   * row-major 4×4, WebGL Y-up. `undefined` when not captured (see
   * `local_bounds` above).
   */
  readonly localToWorld: Float64Array | undefined;
  readonly textureHeight: number;
  /**
   * Get triangle count
   */
  readonly triangleCount: number;
  /**
   * Sampler wrap for the S axis (`IfcSurfaceTexture.RepeatS`): true = repeat.
   */
  readonly textureRepeatS: boolean;
  /**
   * Sampler wrap for the T axis (`IfcSurfaceTexture.RepeatT`): true = repeat.
   */
  readonly textureRepeatT: boolean;
  /**
   * Per-vertex texture coordinates as Float32Array (u, v pairs). Empty when
   * the mesh is untextured.
   */
  readonly uvs: Float32Array;
  /**
   * Get color as [r, g, b, a] array
   */
  readonly color: Float32Array;
  /**
   * Per-element local-frame origin (Float64Array[3], WebGL Y-up, metres):
   * world position of vertex i = `origin + positions[3i..3i+3]`. Returns
   * [0,0,0] when positions are absolute (legacy / local frame off).
   */
  readonly origin: Float64Array;
  /**
   * Get indices as Uint32Array (copy to JS)
   */
  readonly indices: Uint32Array;
  /**
   * Get normals as Float32Array (copy to JS)
   */
  readonly normals: Float32Array;
  /**
   * Get IFC type name (e.g., "IfcWall", "IfcSpace")
   */
  readonly ifcType: string;
  /**
   * Get positions as Float32Array (copy to JS)
   */
  readonly positions: Float32Array;
}

export class MeshOutlineJs {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Ring `i` as a flat `[u0, v0, u1, v1, …]` array, or `undefined` if out of
   * range. The ring is closed implicitly (connect the last point to the
   * first).
   */
  contour(index: number): Float32Array | undefined;
  /**
   * Number of boundary rings (outer + holes).
   */
  readonly contourCount: number;
  /**
   * Element extent (max) along the cut axis, world units.
   */
  readonly axisMax: number;
  /**
   * Element extent (min) along the cut axis, world units.
   */
  readonly axisMin: number;
}

export class PartitionedBatch {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * The instanced IFNS shard bytes (opaque ordinary occurrences). Moves out.
   */
  takeShard(): Uint8Array;
  /**
   * The flat MeshCollection (transparent glass + type-product geometry).
   * Moves out — call once.
   */
  takeMeshes(): MeshCollection | undefined;
  /**
   * Number of occurrences routed into the instanced shard this batch. The viewer
   * folds this into its total mesh count so the count reflects ALL rendered
   * geometry (flat + instanced), not just the flat MeshCollection.
   */
  readonly instancedOccurrences: number;
}

export class ProfileCollection {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get profile at `index`.  Returns `undefined` for out-of-bounds index.
   */
  get(index: number): ProfileEntryJs | undefined;
  /**
   * Number of profiles.
   */
  readonly length: number;
}

export class ProfileEntryJs {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Express ID of the building element.
   */
  readonly expressId: number;
  /**
   * Number of points per hole.
   */
  readonly holeCounts: Uint32Array;
  /**
   * All hole points concatenated: `[x0, y0, x1, y1, …]` (metres).
   */
  readonly holePoints: Float32Array;
  /**
   * Model index for multi-model federation.
   */
  readonly modelIndex: number;
  /**
   * Outer boundary: flat `[x0, y0, x1, y1, …]` in local profile space (metres).
   */
  readonly outerPoints: Float32Array;
  /**
   * Extrusion direction `[dx, dy, dz]` in WebGL Y-up world space (unit vector).
   */
  readonly extrusionDir: Float32Array;
  /**
   * Extrusion depth (metres).
   */
  readonly extrusionDepth: number;
  /**
   * IFC type name (e.g., `"IfcWall"`).
   */
  readonly ifcType: string;
  /**
   * 4 × 4 column-major transform in WebGL Y-up world space.
   * `M * [x, y, 0, 1]ᵀ` gives the world position.
   */
  readonly transform: Float32Array;
}

export class SimplifiedMeshes {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly trisAfter: Uint32Array;
  readonly elementIds: Uint32Array;
  readonly skippedIds: Uint32Array;
  readonly trisBefore: Uint32Array;
  readonly indexCounts: Uint32Array;
  readonly localIndices: Uint32Array;
  readonly vertexCounts: Uint32Array;
  readonly renderIndices: Uint32Array;
  readonly renderNormals: Float32Array;
  /**
   * xyz per element (frame matches the render positions' convention).
   */
  readonly renderOrigins: Float64Array;
  readonly localPositions: Float64Array;
  /**
   * Skip reason per `skippedIds` entry (stable slugs:
   * `no-geometry` / `missing-placement` / `singular-placement` /
   * `empty-result` / `invalid-unit-scale`).
   */
  readonly skippedReasons: any[];
  readonly cavitiesDropped: Uint32Array;
  readonly renderPositions: Float32Array;
  readonly levels: Uint8Array;
}

export class SpacePlateHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Insert a new vertex at `(x, y)` on edge `edge`, subdividing it (no new
   * face). Returns the new vertex id — use it as a `splitFace` endpoint to
   * cut between points that weren't existing corners. Project `(x, y)` onto
   * the edge to keep areas unchanged.
   */
  splitEdge(edge: number, x: number, y: number): number;
  /**
   * Subdivide a face with a partition between two of its vertices. `source`
   * `-1` marks a brand-new partition (materialised as a fresh wall at bake).
   * Returns the kept face and the new face.
   */
  splitFace(face: number, va: number, vb: number, source: number): any;
  /**
   * Move a vertex; returns the rooms it changed. A shared wall is one edge
   * whose endpoints are shared vertices, so one drag updates both rooms.
   */
  dragVertex(v: number, x: number, y: number): any;
  /**
   * Remove a shared wall, unioning the two rooms it separated. Returns the
   * surviving room.
   */
  mergeFaces(edge: number): any;
  /**
   * The face outline offset to a wall boundary, as flat `[x0, y0, …]`: each
   * edge is moved by its own wall's half-thickness — inward when `inset`
   * (the net / inner face), outward otherwise (the gross / outer face).
   * Shared room↔room edges are pinned when pushing outward. Falls back to the
   * centreline outline when no offset applies — so it's always a sane ring.
   * (For a `center` boundary just use `faceOutline`.)
   */
  netOutline(face: number, inset: boolean): Float64Array;
  /**
   * Remove a wall edge, choosing the right semantics from its two faces:
   * two real rooms → union them; a bridge / spur / outer-only wall → delete
   * it and auto-clean the orphaned inner lines and nodes it leaves; a real
   * enclosing wall (room ↔ exterior) → rejected (`BordersExterior`). This is
   * the "remove this wall and tidy up" affordance for the orphan cruft the
   * non-destructive wall arrangement leaves behind. Returns the rooms it
   * changed (empty if the edge bounded no room).
   */
  removeEdge(edge: number): any;
  /**
   * Flat outline `[x0, y0, x1, y1, …]` of a face (no repeated closing vertex).
   */
  faceOutline(face: number): Float64Array;
  /**
   * Face-based gap-room boundary as flat `[x0, y0, …]`: each edge pushed
   * OUTWARD (into the wall) by `factor × the source wall's half-thickness`.
   * `0` → net (the gap / inner faces); `1` → centre axis (½ thickness, the
   * editable node line on the wall mid); `2` → gross outer face.
   */
  gapBoundary(face: number, factor: number): Float64Array;
  /**
   * Dissolve a degree-2 vertex, welding its two edges into one straight
   * edge between the neighbours — the inverse of `splitEdge`, and the
   * "delete this corner / node" affordance. Returns the rooms it changed.
   * Rejects a wall junction (degree ≥ 3) or a weld that would duplicate an
   * edge.
   */
  dissolveVertex(v: number): any;
  /**
   * FACE-BASED build: rooms are the gaps between wall footprint rectangles.
   * `rectCoords` is flat `[x0, y0, x1, y1, x2, y2, x3, y3, …]` — 8 f64 per wall
   * (its 4 plan-rectangle corners, CCW). A bounded arrangement face is a room
   * only if its centroid is outside every rectangle (a gap, not a wall
   * interior). The room outline IS the net (inner-face) area; `gapBoundary`
   * gives the centre axis (½ thickness) and the gross outer face.
   */
  static fromWallRects(rect_coords: Float64Array, snap_tolerance: number, min_area: number): SpacePlateHandle;
  /**
   * The room on the far side of a half-edge (its twin's face), or
   * `undefined`. O(1) — the "who's across this wall" query.
   */
  neighborAcross(edge: number): number | undefined;
  /**
   * Set a face's floor / ceiling planes (the vertical dimension that turns a
   * 2D face into a prismatic space at bake).
   */
  setFaceHeight(face: number, floor_z: number, ceiling_z: number, non_planar: boolean): void;
  /**
   * Nearest live vertex id to `(x, y)` within `tol`, or `undefined`.
   */
  findVertexNear(x: number, y: number, tol: number): number | undefined;
  /**
   * Bounding half-edges of a face paired with their source element —
   * `[{ edge, source }, …]` — for `IfcRelSpaceBoundary` at bake.
   */
  boundingElements(face: number): any;
  /**
   * Build a plate from flat wall-axis segments.
   *
   * `segCoords`: `[ax, ay, bx, by, …]` (length a multiple of 4).
   * `segSources`: one `i32` per segment, `-1` for none.
   * `segHalfThickness`: one `f64` per segment — half the wall's thickness in
   * metres, carried onto the derived edges for `netOutline`. Pass an empty
   * array (or all zeros) when thickness is unknown (centreline only).
   * `snapTolerance` / `minArea`: pass `<= 0` to take the defaults.
   */
  constructor(seg_coords: Float64Array, seg_sources: Int32Array, seg_half_thickness: Float64Array, snap_tolerance: number, min_area: number);
  /**
   * Sweep the whole plate clean: remove dangling spur walls, isolated nodes,
   * and redundant collinear nodes — the "clean up orphans" / eraser action.
   * Area-neutral and idempotent. Returns how many topology elements were
   * pruned (0 = the plate was already clean); the caller re-renders via
   * `snapshot` like any other edit.
   */
  prune(): number;
  /**
   * Author a new room from a flat ring `[x0, y0, x1, y1, …]` (no repeated
   * closing vertex). `source` `-1` marks a user-drawn room. Winding is
   * normalised to CCW; returns the new room patch. The room is its own
   * connected component — it does not merge into existing topology.
   */
  addFace(coords: Float64Array, source: number): any;
  /**
   * Face ids of every live room.
   */
  roomIds(): Uint32Array;
  /**
   * All live rooms as `{ face, area, simple, outline }` patches.
   */
  snapshot(): any;
  /**
   * Deep-copy the plate for an undo/redo snapshot. The clone owns its own
   * heap; the caller must `.free()` it like any handle.
   */
  duplicate(): SpacePlateHandle;
  /**
   * Absolute area (m²) of a face.
   */
  faceArea(face: number): number;
  /**
   * Number of live rooms.
   */
  readonly roomCount: number;
}

export class SymbolicCircle {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly expressId: number;
  readonly startAngle: number;
  /**
   * Check if this is a full circle
   */
  readonly isFullCircle: boolean;
  readonly repIdentifier: string;
  readonly radius: number;
  /**
   * World-Y elevation captured from the placement chain.
   */
  readonly worldY: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly ifcType: string;
  readonly endAngle: number;
}

export class SymbolicFillArea {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly expressId: number;
  readonly holeCount: number;
  readonly hatchAngle: number;
  readonly pointCount: number;
  readonly hasHatching: boolean;
  readonly hatchSpacing: number;
  /**
   * Vertex indices marking the start of each hole. Empty = no holes.
   */
  readonly holesOffsets: Uint32Array;
  readonly repIdentifier: string;
  readonly hatchLineWidth: number;
  readonly hatchAngleSecondary: number;
  readonly fillA: number;
  readonly fillB: number;
  readonly fillG: number;
  readonly fillR: number;
  /**
   * Flattened ring vertices.
   */
  readonly points: Float32Array;
  readonly worldY: number;
  readonly ifcType: string;
}

export class SymbolicPolyline {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get express ID of the parent element
   */
  readonly expressId: number;
  /**
   * Get number of points
   */
  readonly pointCount: number;
  /**
   * Get representation identifier ("Plan", "Annotation", "FootPrint", "Axis")
   */
  readonly repIdentifier: string;
  /**
   * Get 2D points as Float32Array [x1, y1, x2, y2, ...]
   */
  readonly points: Float32Array;
  /**
   * World-Y elevation captured from the placement chain (or first 3D
   * point's Z component). JS uses this as the canonical bucket key.
   */
  readonly worldY: number;
  /**
   * Get IFC type name (e.g., "IfcDoor", "IfcWindow")
   */
  readonly ifcType: string;
  /**
   * Check if this is a closed loop
   */
  readonly isClosed: boolean;
}

export class SymbolicRepresentationCollection {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get circle at index
   */
  getCircle(index: number): SymbolicCircle | undefined;
  /**
   * Get polyline at index
   */
  getPolyline(index: number): SymbolicPolyline | undefined;
  /**
   * Get all express IDs that have symbolic representations
   */
  getExpressIds(): Uint32Array;
  /**
   * Get fill area at index.
   */
  getFill(index: number): SymbolicFillArea | undefined;
  /**
   * Get text annotation at index.
   */
  getText(index: number): SymbolicText | undefined;
  /**
   * Get number of fill areas
   */
  readonly fillCount: number;
  /**
   * Get number of text annotations
   */
  readonly textCount: number;
  /**
   * Get total count of all symbolic items
   */
  readonly totalCount: number;
  /**
   * Get number of circles/arcs
   */
  readonly circleCount: number;
  /**
   * Get number of polylines
   */
  readonly polylineCount: number;
  /**
   * Check if collection is empty
   */
  readonly isEmpty: boolean;
}

export class SymbolicText {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly expressId: number;
  readonly repIdentifier: string;
  readonly x: number;
  readonly y: number;
  readonly dirX: number;
  readonly dirY: number;
  readonly height: number;
  readonly colorA: number;
  readonly colorB: number;
  readonly colorG: number;
  readonly colorR: number;
  readonly content: string;
  readonly worldY: number;
  readonly ifcType: string;
  readonly alignment: string;
  readonly targetPx: number;
}

/**
 * Get WASM memory to allow JavaScript to create TypedArray views
 */
export function get_memory(): any;

/**
 * Initialize the WASM module.
 *
 * This function is called automatically when the WASM module is loaded.
 * It sets up panic hooks for better error messages in the browser console.
 */
export function init(): void;

/**
 * Compute the winding-robust 2D footprint outline of a triangle mesh.
 *
 * `positions` is flat XYZ; `indices` is flat triangle indices. `axis` is
 * 0/1/2 = x/y/z (the cut axis, WebGL Y-up). Returns `undefined` when the mesh
 * has no triangles or projects to nothing.
 *
 * ```javascript
 * const outline = meshOutline2d(positions, indices, 1, false); // axis 1 = y
 * if (outline) {
 *   for (let i = 0; i < outline.contourCount; i++) {
 *     const ring = outline.contour(i); // Float32Array of [u0, v0, u1, v1, ...]
 *   }
 *   outline.free();
 * }
 * ```
 */
export function meshOutline2d(positions: Float32Array, indices: Uint32Array, axis: number, flipped: boolean): MeshOutlineJs | undefined;

/**
 * Get the version of IFC-Lite.
 *
 * # Returns
 *
 * Version string (e.g., "0.1.0")
 *
 * # Example
 *
 * ```javascript
 * console.log(`IFC-Lite version: ${version()}`);
 * ```
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_clashrunresult_free: (a: number, b: number) => void;
  readonly __wbg_clashsession_free: (a: number, b: number) => void;
  readonly __wbg_gridaxiscollection_free: (a: number, b: number) => void;
  readonly __wbg_gridaxisjs_free: (a: number, b: number) => void;
  readonly __wbg_ifcapi_free: (a: number, b: number) => void;
  readonly __wbg_meshcollection_free: (a: number, b: number) => void;
  readonly __wbg_meshdatajs_free: (a: number, b: number) => void;
  readonly __wbg_meshoutlinejs_free: (a: number, b: number) => void;
  readonly __wbg_partitionedbatch_free: (a: number, b: number) => void;
  readonly __wbg_profilecollection_free: (a: number, b: number) => void;
  readonly __wbg_profileentryjs_free: (a: number, b: number) => void;
  readonly __wbg_simplifiedmeshes_free: (a: number, b: number) => void;
  readonly __wbg_spaceplatehandle_free: (a: number, b: number) => void;
  readonly __wbg_symboliccircle_free: (a: number, b: number) => void;
  readonly __wbg_symbolicfillarea_free: (a: number, b: number) => void;
  readonly __wbg_symbolicpolyline_free: (a: number, b: number) => void;
  readonly __wbg_symbolicrepresentationcollection_free: (a: number, b: number) => void;
  readonly __wbg_symbolictext_free: (a: number, b: number) => void;
  readonly clashrunresult_a: (a: number, b: number) => void;
  readonly clashrunresult_b: (a: number, b: number) => void;
  readonly clashrunresult_bounds: (a: number, b: number) => void;
  readonly clashrunresult_distance: (a: number, b: number) => void;
  readonly clashrunresult_points: (a: number, b: number) => void;
  readonly clashrunresult_status: (a: number, b: number) => void;
  readonly clashsession_ingest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
  readonly clashsession_new: () => number;
  readonly clashsession_runRule: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
  readonly gridaxiscollection_getAxis: (a: number, b: number) => number;
  readonly gridaxiscollection_isEmpty: (a: number) => number;
  readonly gridaxiscollection_length: (a: number) => number;
  readonly gridaxisjs_axisId: (a: number) => number;
  readonly gridaxisjs_end: (a: number) => number;
  readonly gridaxisjs_gridId: (a: number) => number;
  readonly gridaxisjs_start: (a: number) => number;
  readonly gridaxisjs_tag: (a: number, b: number) => void;
  readonly ifcapi_buildPrePassOnce: (a: number, b: number, c: number) => number;
  readonly ifcapi_buildPrePassStreaming: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly ifcapi_buildPrePassStreamingSharded: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => void;
  readonly ifcapi_clearPrePassCache: (a: number) => void;
  readonly ifcapi_diagnoseGeometry: (a: number, b: number, c: number) => number;
  readonly ifcapi_exportCsv: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly ifcapi_exportGlb: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
  readonly ifcapi_exportGlbFromMeshes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number) => void;
  readonly ifcapi_exportHbjson: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly ifcapi_exportIfcx: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly ifcapi_exportJson: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly ifcapi_exportJsonld: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
  readonly ifcapi_exportKmz: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => void;
  readonly ifcapi_exportKmzFromMeshes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number) => void;
  readonly ifcapi_exportMerged: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly ifcapi_exportObj: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly ifcapi_exportStep: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
  readonly ifcapi_extractProfiles: (a: number, b: number, c: number, d: number) => number;
  readonly ifcapi_finalizePrepassStyles: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number) => void;
  readonly ifcapi_getMemory: (a: number) => number;
  readonly ifcapi_getPipelineDiagnostics: (a: number) => number;
  readonly ifcapi_is_ready: (a: number) => number;
  readonly ifcapi_new: () => number;
  readonly ifcapi_parseAlignmentLines: (a: number, b: number, c: number) => number;
  readonly ifcapi_parseGridAxes: (a: number, b: number, c: number) => number;
  readonly ifcapi_parseGridLines: (a: number, b: number, c: number) => number;
  readonly ifcapi_parseSymbolicRepresentations: (a: number, b: number, c: number) => number;
  readonly ifcapi_processGeometryBatch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number) => number;
  readonly ifcapi_processGeometryBatchFromSource: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => number;
  readonly ifcapi_processGeometryBatchInstanced: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number) => void;
  readonly ifcapi_processGeometryBatchPartitioned: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number) => number;
  readonly ifcapi_processGeometryBatchPartitionedFromSource: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number) => number;
  readonly ifcapi_resolveStyledItemsShard: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly ifcapi_scanEntitiesFast: (a: number, b: number, c: number) => number;
  readonly ifcapi_scanEntitiesFastBytes: (a: number, b: number, c: number) => number;
  readonly ifcapi_scanEntityIndexShard: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly ifcapi_scanGeometryEntitiesFast: (a: number, b: number, c: number) => number;
  readonly ifcapi_setComputeGeometryHashes: (a: number, b: number, c: number) => void;
  readonly ifcapi_setEntityIndex: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
  readonly ifcapi_setInstantiatedTypeIds: (a: number, b: number, c: number) => void;
  readonly ifcapi_setMappedInstancePlan: (a: number, b: number, c: number) => void;
  readonly ifcapi_setMaterialLayerIndex: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => void;
  readonly ifcapi_setMergeLayers: (a: number, b: number) => void;
  readonly ifcapi_setRectParamFastPath: (a: number, b: number) => void;
  readonly ifcapi_setReferencedRepmaps: (a: number, b: number, c: number) => void;
  readonly ifcapi_setSkipSmallCuts: (a: number, b: number) => void;
  readonly ifcapi_setSourceBytes: (a: number, b: number, c: number) => void;
  readonly ifcapi_setTessellationQuality: (a: number, b: number, c: number, d: number) => void;
  readonly ifcapi_simplifyMeshes: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number) => void;
  readonly ifcapi_version: (a: number, b: number) => void;
  readonly meshOutline2d: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly meshcollection_buildingRotation: (a: number, b: number) => void;
  readonly meshcollection_diagnostics: (a: number) => number;
  readonly meshcollection_geometryHashCount: (a: number) => number;
  readonly meshcollection_geometryHashIds: (a: number) => number;
  readonly meshcollection_geometryHashValues: (a: number) => number;
  readonly meshcollection_get: (a: number, b: number) => number;
  readonly meshcollection_hasRtcOffset: (a: number) => number;
  readonly meshcollection_length: (a: number) => number;
  readonly meshcollection_rtcOffsetX: (a: number) => number;
  readonly meshcollection_rtcOffsetY: (a: number) => number;
  readonly meshcollection_rtcOffsetZ: (a: number) => number;
  readonly meshcollection_takeMesh: (a: number, b: number) => number;
  readonly meshcollection_totalTriangles: (a: number) => number;
  readonly meshcollection_totalVertices: (a: number) => number;
  readonly meshdatajs_color: (a: number, b: number) => void;
  readonly meshdatajs_expressId: (a: number) => number;
  readonly meshdatajs_geometryClass: (a: number) => number;
  readonly meshdatajs_hasTexture: (a: number) => number;
  readonly meshdatajs_ifcType: (a: number, b: number) => void;
  readonly meshdatajs_indices: (a: number) => number;
  readonly meshdatajs_localBounds: (a: number, b: number) => void;
  readonly meshdatajs_localToWorld: (a: number, b: number) => void;
  readonly meshdatajs_normals: (a: number) => number;
  readonly meshdatajs_origin: (a: number) => number;
  readonly meshdatajs_positions: (a: number) => number;
  readonly meshdatajs_shadingColor: (a: number, b: number) => void;
  readonly meshdatajs_textureHeight: (a: number) => number;
  readonly meshdatajs_textureRepeatS: (a: number) => number;
  readonly meshdatajs_textureRepeatT: (a: number) => number;
  readonly meshdatajs_textureRgba: (a: number) => number;
  readonly meshdatajs_textureWidth: (a: number) => number;
  readonly meshdatajs_triangleCount: (a: number) => number;
  readonly meshdatajs_uvs: (a: number) => number;
  readonly meshdatajs_vertexCount: (a: number) => number;
  readonly meshoutlinejs_axisMax: (a: number) => number;
  readonly meshoutlinejs_axisMin: (a: number) => number;
  readonly meshoutlinejs_contour: (a: number, b: number) => number;
  readonly meshoutlinejs_contourCount: (a: number) => number;
  readonly partitionedbatch_instancedOccurrences: (a: number) => number;
  readonly partitionedbatch_takeMeshes: (a: number) => number;
  readonly partitionedbatch_takeShard: (a: number, b: number) => void;
  readonly profilecollection_get: (a: number, b: number) => number;
  readonly profilecollection_length: (a: number) => number;
  readonly profileentryjs_expressId: (a: number) => number;
  readonly profileentryjs_extrusionDepth: (a: number) => number;
  readonly profileentryjs_extrusionDir: (a: number) => number;
  readonly profileentryjs_holeCounts: (a: number) => number;
  readonly profileentryjs_holePoints: (a: number) => number;
  readonly profileentryjs_ifcType: (a: number, b: number) => void;
  readonly profileentryjs_modelIndex: (a: number) => number;
  readonly profileentryjs_outerPoints: (a: number) => number;
  readonly profileentryjs_transform: (a: number) => number;
  readonly simplifiedmeshes_cavitiesDropped: (a: number, b: number) => void;
  readonly simplifiedmeshes_elementIds: (a: number, b: number) => void;
  readonly simplifiedmeshes_indexCounts: (a: number, b: number) => void;
  readonly simplifiedmeshes_levels: (a: number, b: number) => void;
  readonly simplifiedmeshes_localIndices: (a: number, b: number) => void;
  readonly simplifiedmeshes_localPositions: (a: number, b: number) => void;
  readonly simplifiedmeshes_renderIndices: (a: number, b: number) => void;
  readonly simplifiedmeshes_renderNormals: (a: number, b: number) => void;
  readonly simplifiedmeshes_renderOrigins: (a: number, b: number) => void;
  readonly simplifiedmeshes_renderPositions: (a: number, b: number) => void;
  readonly simplifiedmeshes_skippedIds: (a: number, b: number) => void;
  readonly simplifiedmeshes_skippedReasons: (a: number, b: number) => void;
  readonly simplifiedmeshes_trisAfter: (a: number, b: number) => void;
  readonly simplifiedmeshes_trisBefore: (a: number, b: number) => void;
  readonly simplifiedmeshes_vertexCounts: (a: number, b: number) => void;
  readonly spaceplatehandle_addFace: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly spaceplatehandle_boundingElements: (a: number, b: number, c: number) => void;
  readonly spaceplatehandle_dissolveVertex: (a: number, b: number, c: number) => void;
  readonly spaceplatehandle_dragVertex: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly spaceplatehandle_duplicate: (a: number) => number;
  readonly spaceplatehandle_faceArea: (a: number, b: number) => number;
  readonly spaceplatehandle_faceOutline: (a: number, b: number, c: number) => void;
  readonly spaceplatehandle_findVertexNear: (a: number, b: number, c: number, d: number) => number;
  readonly spaceplatehandle_fromWallRects: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly spaceplatehandle_gapBoundary: (a: number, b: number, c: number, d: number) => void;
  readonly spaceplatehandle_mergeFaces: (a: number, b: number, c: number) => void;
  readonly spaceplatehandle_neighborAcross: (a: number, b: number) => number;
  readonly spaceplatehandle_netOutline: (a: number, b: number, c: number, d: number) => void;
  readonly spaceplatehandle_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
  readonly spaceplatehandle_prune: (a: number) => number;
  readonly spaceplatehandle_removeEdge: (a: number, b: number, c: number) => void;
  readonly spaceplatehandle_roomCount: (a: number) => number;
  readonly spaceplatehandle_roomIds: (a: number, b: number) => void;
  readonly spaceplatehandle_setFaceHeight: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly spaceplatehandle_snapshot: (a: number, b: number) => void;
  readonly spaceplatehandle_splitEdge: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly spaceplatehandle_splitFace: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly symboliccircle_centerX: (a: number) => number;
  readonly symboliccircle_centerY: (a: number) => number;
  readonly symboliccircle_endAngle: (a: number) => number;
  readonly symboliccircle_expressId: (a: number) => number;
  readonly symboliccircle_ifcType: (a: number, b: number) => void;
  readonly symboliccircle_isFullCircle: (a: number) => number;
  readonly symboliccircle_radius: (a: number) => number;
  readonly symboliccircle_repIdentifier: (a: number, b: number) => void;
  readonly symboliccircle_startAngle: (a: number) => number;
  readonly symboliccircle_worldY: (a: number) => number;
  readonly symbolicfillarea_fillA: (a: number) => number;
  readonly symbolicfillarea_fillB: (a: number) => number;
  readonly symbolicfillarea_fillG: (a: number) => number;
  readonly symbolicfillarea_fillR: (a: number) => number;
  readonly symbolicfillarea_hasHatching: (a: number) => number;
  readonly symbolicfillarea_hatchAngle: (a: number) => number;
  readonly symbolicfillarea_hatchAngleSecondary: (a: number) => number;
  readonly symbolicfillarea_hatchLineWidth: (a: number) => number;
  readonly symbolicfillarea_hatchSpacing: (a: number) => number;
  readonly symbolicfillarea_holeCount: (a: number) => number;
  readonly symbolicfillarea_holesOffsets: (a: number) => number;
  readonly symbolicfillarea_ifcType: (a: number, b: number) => void;
  readonly symbolicfillarea_pointCount: (a: number) => number;
  readonly symbolicfillarea_points: (a: number) => number;
  readonly symbolicfillarea_repIdentifier: (a: number, b: number) => void;
  readonly symbolicfillarea_worldY: (a: number) => number;
  readonly symbolicpolyline_expressId: (a: number) => number;
  readonly symbolicpolyline_ifcType: (a: number, b: number) => void;
  readonly symbolicpolyline_isClosed: (a: number) => number;
  readonly symbolicpolyline_points: (a: number) => number;
  readonly symbolicpolyline_repIdentifier: (a: number, b: number) => void;
  readonly symbolicrepresentationcollection_circleCount: (a: number) => number;
  readonly symbolicrepresentationcollection_fillCount: (a: number) => number;
  readonly symbolicrepresentationcollection_getCircle: (a: number, b: number) => number;
  readonly symbolicrepresentationcollection_getExpressIds: (a: number, b: number) => void;
  readonly symbolicrepresentationcollection_getFill: (a: number, b: number) => number;
  readonly symbolicrepresentationcollection_getPolyline: (a: number, b: number) => number;
  readonly symbolicrepresentationcollection_getText: (a: number, b: number) => number;
  readonly symbolicrepresentationcollection_isEmpty: (a: number) => number;
  readonly symbolicrepresentationcollection_polylineCount: (a: number) => number;
  readonly symbolicrepresentationcollection_textCount: (a: number) => number;
  readonly symbolicrepresentationcollection_totalCount: (a: number) => number;
  readonly symbolictext_alignment: (a: number, b: number) => void;
  readonly symbolictext_colorA: (a: number) => number;
  readonly symbolictext_content: (a: number, b: number) => void;
  readonly symbolictext_ifcType: (a: number, b: number) => void;
  readonly symbolictext_repIdentifier: (a: number, b: number) => void;
  readonly symbolictext_targetPx: (a: number) => number;
  readonly version: (a: number) => void;
  readonly init: () => void;
  readonly symbolicpolyline_pointCount: (a: number) => number;
  readonly get_memory: () => number;
  readonly symbolicfillarea_expressId: (a: number) => number;
  readonly symbolicpolyline_worldY: (a: number) => number;
  readonly symbolictext_colorB: (a: number) => number;
  readonly symbolictext_colorG: (a: number) => number;
  readonly symbolictext_colorR: (a: number) => number;
  readonly symbolictext_dirX: (a: number) => number;
  readonly symbolictext_dirY: (a: number) => number;
  readonly symbolictext_expressId: (a: number) => number;
  readonly symbolictext_height: (a: number) => number;
  readonly symbolictext_worldY: (a: number) => number;
  readonly symbolictext_x: (a: number) => number;
  readonly symbolictext_y: (a: number) => number;
  readonly __wbindgen_export: (a: number, b: number) => number;
  readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export3: (a: number) => void;
  readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
