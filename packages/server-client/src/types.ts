// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Configuration options for the IFC server client.
 */
export interface ServerConfig {
  /** Base URL of the IFC-Lite server (e.g., 'https://ifc-lite.railway.app') */
  baseUrl: string;
  /** Request timeout in milliseconds (default: 300000 = 5 minutes) */
  timeout?: number;
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on every request.
   * Required when the server sets `IFC_SERVER_API_TOKEN` (its parse/cache
   * routes then reject unauthenticated calls); previously no TS client
   * could authenticate at all (alignment audit).
   */
  token?: string;
}

/**
 * Individual mesh data with geometry and metadata.
 */
export interface MeshData {
  /** Express ID of the IFC element */
  express_id: number;
  /** IFC type name (e.g., "IfcWall") */
  ifc_type: string;
  /** Vertex positions as flat array (x, y, z triplets) */
  positions: Float32Array;
  /** Vertex normals as flat array (x, y, z triplets) */
  normals: Float32Array;
  /** Triangle indices */
  indices: Uint32Array;
  /** RGBA color [r, g, b, a] in 0-1 range */
  color: [number, number, number, number];
  /** IfcGloballyUniqueId of the source element, when extracted. */
  global_id?: string;
  /** Element Name attribute, when extracted. */
  name?: string;
  /** Presentation layer assignment, when extracted. */
  presentation_layer?: string;
  /** Resolved material name for this (sub-)mesh, when known. */
  material_name?: string;
  /** Source geometry item id for per-item styled sub-meshes. */
  geometry_item_id?: number;
  /** Space/zone properties attached to the element, when extracted. */
  properties?: Record<string, string>;
}

/**
 * Model metadata extracted from the IFC file.
 */
export interface ModelMetadata {
  /** IFC schema version (e.g., "IFC2X3", "IFC4", "IFC4X3") */
  schema_version: string;
  /** Total number of entities in the file */
  entity_count: number;
  /** Number of geometry-bearing entities */
  geometry_entity_count: number;
  /** Coordinate system information */
  coordinate_info: CoordinateInfo;
  /**
   * Length unit scale to convert model length values to metres (e.g. `0.001`
   * for millimetres). Absent on older servers — treat as `1`.
   */
  length_unit_scale?: number;
  /**
   * Georeferencing (`IfcMapConversion` + `IfcProjectedCRS`). Absent when the
   * model carries no map-conversion data.
   */
  georeferencing?: Georeferencing;
}

/**
 * Georeferencing metadata (`IfcMapConversion` + `IfcProjectedCRS`).
 *
 * Surfaced on every geometry endpoint's `ModelMetadata`, matching the browser
 * parser's `extractGeoreferencing`.
 */
export interface Georeferencing {
  /** Projected CRS name from `IfcProjectedCRS.Name` (e.g. "EPSG:32632"). */
  crs_name?: string;
  /** Geodetic datum (e.g. "WGS84"). */
  geodetic_datum?: string;
  /** Vertical datum (e.g. "NAVD88"). */
  vertical_datum?: string;
  /** Map projection (e.g. "UTM"). */
  map_projection?: string;
  /** False easting — X offset to the map CRS, in the project's length unit. */
  eastings: number;
  /** False northing — Y offset to the map CRS, in the project's length unit. */
  northings: number;
  /** Orthogonal height — Z offset to the map CRS. */
  orthogonal_height: number;
  /** X-axis abscissa: cosine of the rotation to grid north. */
  x_axis_abscissa: number;
  /** X-axis ordinate: sine of the rotation to grid north. */
  x_axis_ordinate: number;
  /** Scale factor applied during the local→map transform (default 1). */
  scale: number;
  /** Rotation to grid north in degrees, derived from the X-axis direction. */
  rotation_degrees: number;
  /** Local→map transform as a column-major 4×4 matrix (16 values). */
  transform_matrix: number[];
  /** CRS description from `IfcProjectedCRS.Description`. */
  crs_description?: string;
  /** Map zone (e.g. "32N") from `IfcProjectedCRS.MapZone`. */
  map_zone?: string;
  /** Map unit name from `IfcProjectedCRS.MapUnit` (e.g. "MILLIMETRE"). */
  map_unit?: string;
  /** Scale converting MapConversion values to metres (0.001 for mm). */
  map_unit_scale?: number;
  /** Provenance: "mapConversion" | "ePSetMapConversion" | "siteLocation". */
  source?: string;
}

/**
 * Coordinate system information.
 */
export interface CoordinateInfo {
  /** Origin shift applied to coordinates (for RTC rendering) */
  origin_shift: [number, number, number];
  /** Whether the model is geo-referenced */
  is_geo_referenced: boolean;
}

/**
 * Processing statistics.
 */
export interface ProcessingStats {
  /** Total number of meshes generated */
  total_meshes: number;
  /** Total number of vertices */
  total_vertices: number;
  /** Total number of triangles */
  total_triangles: number;
  /** Time spent parsing entities (ms) */
  parse_time_ms: number;
  /** Time spent scanning entities and building job lists (ms). */
  entity_scan_time_ms?: number;
  /** Time spent resolving lookups, styles, and optional metadata (ms). */
  lookup_time_ms?: number;
  /** Time spent in geometry preprocessing before extraction (ms). */
  preprocess_time_ms?: number;
  /** Time spent processing geometry (ms) */
  geometry_time_ms: number;
  /** Total processing time (ms) */
  total_time_ms: number;
  /** Whether result was from cache */
  from_cache: boolean;
  /**
   * Total CSG boolean failures recorded during geometry extraction (the
   * server-side mirror of the browser console CSG diagnostics). Optional:
   * absent on responses from servers predating this field.
   */
  total_csg_failures?: number;
  /** Number of distinct products with at least one CSG failure. */
  products_with_failures?: number;
  /**
   * Full CSG / opening diagnostics aggregated by the native geometry pass (the
   * `GeometryDiagnostics` contract; fields are camelCase to match the Rust
   * `rename_all`). Absent on responses from servers predating this field, or when
   * nothing diagnostic-worthy happened.
   */
  geometry_diagnostics?: GeometryDiagnostics;
}

/**
 * CSG / opening diagnostics for a geometry pass. Mirrors the Rust
 * `GeometryDiagnostics` (camelCase serde) the server and the WASM batch path both
 * emit. `totalCsgFailures` and the classification counts are exact;
 * `productsWithFailures`, `hostsWithOpenings` and `silentNoOps` are batch-summed
 * upper bounds.
 */
export interface GeometryDiagnostics {
  totalCsgFailures: number;
  productsWithFailures: number;
  hostsWithOpenings: number;
  classification: {
    rectangular: number;
    diagonal: number;
    nonRectangular: number;
    total: number;
  };
  failuresByReason: Array<{ reason: string; count: number }>;
  silentNoOps: number;
  rectFast: {
    fired: number;
    openingsCut: number;
    deferHostNotBox: number;
    deferNotThrough: number;
    deferOffFace: number;
    deferNearEdge: number;
    deferNoOpenings: number;
    deferTooManyOpenings?: number;
  };
  worstHosts: Array<{
    productId: number;
    ifcType: string;
    openings: number;
    csgFailures: number;
    firstFailureLabel?: string;
  }>;
}

// ============================================
// 2D Symbol Data (IfcAnnotation + IfcGrid)
// ============================================

/**
 * A single `IfcGridAxis` tag + axis curve (compact endpoint-pair shape).
 */
export interface SymbolicGridAxis {
  express_id: number;
  grid_express_id: number;
  tag: string;
  /** Endpoint pair `[x0, y0, x1, y1]` in metres (plan view). */
  endpoints: [number, number, number, number];
  world_y: number;
}

/**
 * A 2D polyline (`IfcPolyline`, `IfcIndexedPolyCurve`, tessellated ellipses,
 * trimmed-curve arcs, grid axis lines).
 */
export interface SymbolicPolyline {
  express_id: number;
  ifc_type: string;
  /** Flat `[x0, y0, x1, y1, …]` plan-view coordinates. */
  points: number[];
  closed: boolean;
  world_y: number;
  representation: string;
}

/**
 * A 2D circle / arc (`IfcCircle`).
 */
export interface SymbolicCircle {
  express_id: number;
  ifc_type: string;
  center_x: number;
  center_y: number;
  radius: number;
  world_y: number;
  /** Start angle in radians (0 for a full circle). */
  start_angle: number;
  /** End angle in radians (`2π` for a full circle). */
  end_angle: number;
  representation: string;
}

/**
 * A 2D text annotation (`IfcTextLiteral` / grid bubble glyphs + tags).
 */
export interface SymbolicText {
  express_id: number;
  ifc_type: string;
  x: number;
  y: number;
  /** Baseline orientation as a `(cos, sin)` pair. */
  dir_x: number;
  dir_y: number;
  /** Font cap height in model units (already unit-scaled). */
  height: number;
  content: string;
  /** IFC `BoxAlignment` (`top-left`, `center`, …). Empty when absent. */
  alignment: string;
  world_y: number;
  /** sRGB straight-alpha colour `[r, g, b, a]`. */
  color: [number, number, number, number];
  /** Per-instance target screen-pixel cap height (`0` = renderer default). */
  target_px: number;
  representation: string;
}

/**
 * A 2D filled region (`IfcAnnotationFillArea`). Outer ring + optional holes
 * packed into a single `points` buffer; `holes_offsets[i]` is the vertex index
 * where hole `i` begins.
 */
export interface SymbolicFillArea {
  express_id: number;
  ifc_type: string;
  points: number[];
  holes_offsets: number[];
  fill_color: [number, number, number, number];
  has_hatching: boolean;
  hatch_spacing: number;
  hatch_angle: number;
  /**
   * Secondary cross-hatch angle. `null` when absent — the Rust model uses
   * `f32::NAN`, which `serde_json` serializes as JSON `null` (not `NaN`).
   */
  hatch_angle_secondary: number | null;
  hatch_line_width: number;
  world_y: number;
  representation: string;
}

/**
 * 2D symbol data extracted from `IfcAnnotation` and `IfcGrid` entities.
 *
 * Returned inline by `POST /api/v1/parse` and the streaming `complete` events,
 * and fetched by cache key from `GET /api/v1/parse/symbolic/{cache_key}` for the
 * binary (Parquet) transports. Arrays may be empty when the model carries no
 * 2D symbols.
 */
export interface SymbolicData {
  grid_axes: SymbolicGridAxis[];
  polylines: SymbolicPolyline[];
  circles: SymbolicCircle[];
  texts: SymbolicText[];
  fills: SymbolicFillArea[];
}

/**
 * Full parse response with all meshes.
 */
export interface ParseResponse {
  /** Cache key for this result (SHA256 of file content) */
  cache_key: string;
  /** All meshes extracted from the IFC file */
  meshes: MeshData[];
  /**
   * Coordinate space of serialized mesh vertices: `site_local`,
   * `model_rtc`, or `raw_ifc`. Absent on older servers.
   */
  mesh_coordinate_space?: string;
  /** IfcSite ObjectPlacement as a column-major 4×4 matrix (metres). */
  site_transform?: number[];
  /** IfcBuilding ObjectPlacement as a column-major 4×4 matrix (metres). */
  building_transform?: number[];
  /** Model metadata */
  metadata: ModelMetadata;
  /** Processing statistics */
  stats: ProcessingStats;
  /**
   * 2D symbol data (`IfcAnnotation` + `IfcGrid`). Omitted when the model has
   * no 2D symbols.
   */
  symbolic_data?: SymbolicData;
}

/**
 * Metadata-only response (no geometry).
 */
export interface MetadataResponse {
  /** Total number of entities */
  entity_count: number;
  /** Number of geometry-bearing entities */
  geometry_count: number;
  /** IFC schema version */
  schema_version: string;
  /** File size in bytes */
  file_size: number;
}

/**
 * Health check response.
 */
export interface HealthResponse {
  /** Server status */
  status: string;
  /** Server version */
  version: string;
  /** Service name */
  service: string;
}

/**
 * Error response from the server.
 */
export interface ErrorResponse {
  /** Error message */
  error: string;
  /** Error code */
  code: string;
}

/**
 * Server-Sent Event types for streaming responses.
 */
export type StreamEvent =
  | StreamStartEvent
  | StreamProgressEvent
  | StreamBatchEvent
  | StreamCompleteEvent
  | StreamErrorEvent;

/**
 * Initial event with estimated totals.
 */
export interface StreamStartEvent {
  type: 'start';
  /** Estimated number of geometry entities */
  total_estimate: number;
}

/**
 * Progress update event.
 */
export interface StreamProgressEvent {
  type: 'progress';
  /** Number of entities processed */
  processed: number;
  /** Total entities to process */
  total: number;
  /** Current entity type being processed */
  current_type: string;
}

/**
 * Batch of processed meshes.
 */
export interface StreamBatchEvent {
  type: 'batch';
  /** Meshes in this batch */
  meshes: MeshData[];
  /** Batch sequence number */
  batch_number: number;
}

/**
 * Processing complete event.
 */
export interface StreamCompleteEvent {
  type: 'complete';
  /** Final processing statistics */
  stats: ProcessingStats;
  /** Model metadata */
  metadata: ModelMetadata;
  /** Cache key for the result */
  cache_key: string;
  /**
   * 2D symbol data (`IfcAnnotation` + `IfcGrid`). Omitted when the model has
   * no 2D symbols.
   */
  symbolic_data?: SymbolicData;
}

/**
 * Error event.
 */
export interface StreamErrorEvent {
  type: 'error';
  /** Error message */
  message: string;
}

/**
 * Metadata header from Parquet response (sent via X-IFC-Metadata header).
 */
export interface ParquetMetadataHeader {
  /** Cache key for this result (SHA256 of file content) */
  cache_key: string;
  /** Model metadata */
  metadata: ModelMetadata;
  /** Processing statistics */
  stats: ProcessingStats;
  /** Declares the coordinate space used by serialized mesh vertices. */
  mesh_coordinate_space?: string;
  /** IfcSite ObjectPlacement as a column-major 4x4 matrix (in meters). */
  site_transform?: number[];
  /** IfcBuilding ObjectPlacement as a column-major 4x4 matrix (in meters). */
  building_transform?: number[];
  /** Data model statistics (if included) */
  data_model_stats?: {
    entity_count: number;
    property_set_count: number;
    relationship_count: number;
    spatial_node_count: number;
  };
}

/**
 * Parquet parse response with decoded geometry.
 */
export interface ParquetParseResponse {
  /** Cache key for this result (SHA256 of file content) */
  cache_key: string;
  /** All meshes extracted from the IFC file */
  meshes: MeshData[];
  /** Declares the coordinate space used by serialized mesh vertices. */
  mesh_coordinate_space?: string;
  /** IfcSite ObjectPlacement as a column-major 4x4 matrix (in meters). */
  site_transform?: number[];
  /** IfcBuilding ObjectPlacement as a column-major 4x4 matrix (in meters). */
  building_transform?: number[];
  /** Model metadata */
  metadata: ModelMetadata;
  /** Processing statistics */
  stats: ProcessingStats;
  /** Additional stats for Parquet transfer */
  parquet_stats: {
    /** Size of Parquet payload in bytes */
    payload_size: number;
    /** Time spent decoding Parquet (ms) */
    decode_time_ms: number;
  };
  /** Data model binary (Parquet format) - optional */
  data_model?: ArrayBuffer;
}

/**
 * Optimization statistics from the server.
 */
export interface OptimizationStats {
  /** Number of input meshes before deduplication */
  input_meshes: number;
  /** Number of unique meshes after deduplication */
  unique_meshes: number;
  /** Number of unique materials */
  unique_materials: number;
  /** Mesh reuse ratio (higher = more instancing benefit) */
  mesh_reuse_ratio: number;
  /** Whether normals are included in the response */
  has_normals: boolean;
}

/**
 * Metadata header from optimized Parquet response.
 */
export interface OptimizedParquetMetadataHeader {
  /** Cache key for this result */
  cache_key: string;
  /** Model metadata */
  metadata: ModelMetadata;
  /** Processing statistics */
  stats: ProcessingStats;
  /** Declares the coordinate space used by serialized mesh vertices. */
  mesh_coordinate_space?: string;
  /** IfcSite ObjectPlacement as a column-major 4x4 matrix (in meters). */
  site_transform?: number[];
  /** IfcBuilding ObjectPlacement as a column-major 4x4 matrix (in meters). */
  building_transform?: number[];
  /** Optimization statistics */
  optimization_stats: OptimizationStats;
  /** Vertex multiplier for dequantization (default: 10000 = 0.1mm precision) */
  vertex_multiplier: number;
}

/**
 * Optimized Parquet parse response with ara3d BOS-compatible format.
 */
export interface OptimizedParquetParseResponse {
  /** Cache key for this result */
  cache_key: string;
  /** All meshes extracted from the IFC file */
  meshes: MeshData[];
  /** Declares the coordinate space used by serialized mesh vertices. */
  mesh_coordinate_space?: string;
  /** IfcSite ObjectPlacement as a column-major 4x4 matrix (in meters). */
  site_transform?: number[];
  /** IfcBuilding ObjectPlacement as a column-major 4x4 matrix (in meters). */
  building_transform?: number[];
  /** Model metadata */
  metadata: ModelMetadata;
  /** Processing statistics */
  stats: ProcessingStats;
  /** Optimization statistics */
  optimization_stats: OptimizationStats;
  /** Transfer/decode stats */
  parquet_stats: {
    /** Size of Parquet payload in bytes */
    payload_size: number;
    /** Time spent decoding Parquet (ms) */
    decode_time_ms: number;
  };
}

// ============================================
// Streaming Parquet Types
// ============================================

/**
 * SSE event types for Parquet streaming responses.
 */
export type ParquetStreamEvent =
  | ParquetStreamStartEvent
  | ParquetStreamProgressEvent
  | ParquetStreamBatchEvent
  | ParquetStreamCompleteEvent
  | ParquetStreamErrorEvent;

/**
 * Initial streaming event with estimated totals.
 */
export interface ParquetStreamStartEvent {
  type: 'start';
  /** Estimated number of geometry entities */
  total_estimate: number;
  /** Cache key for this file (use for data model fetch) */
  cache_key: string;
}

/**
 * Progress update event.
 */
export interface ParquetStreamProgressEvent {
  type: 'progress';
  /** Number of entities processed */
  processed: number;
  /** Total entities to process */
  total: number;
}

/**
 * Batch of geometry data as Parquet.
 */
export interface ParquetStreamBatchEvent {
  type: 'batch';
  /** Base64-encoded Parquet data */
  data: string;
  /** Number of meshes in this batch */
  mesh_count: number;
  /** Batch sequence number (1-indexed) */
  batch_number: number;
}

/**
 * Processing complete event.
 */
export interface ParquetStreamCompleteEvent {
  type: 'complete';
  /** Final processing statistics */
  stats: ProcessingStats;
  /** Model metadata */
  metadata: ModelMetadata;
  /**
   * 2D symbol data (`IfcAnnotation` + `IfcGrid`). Omitted when the model has
   * no 2D symbols.
   */
  symbolic_data?: SymbolicData;
}

/**
 * Error event.
 */
export interface ParquetStreamErrorEvent {
  type: 'error';
  /** Error message */
  message: string;
}

/**
 * Decoded geometry batch from streaming.
 */
export interface ParquetBatch {
  /** Meshes in this batch */
  meshes: MeshData[];
  /** Batch sequence number */
  batch_number: number;
  /** Decode time in ms */
  decode_time_ms: number;
}

/**
 * Complete streaming result.
 */
export interface ParquetStreamResult {
  /** Cache key for data model fetch */
  cache_key: string;
  /** Total meshes received */
  total_meshes: number;
  /** Processing statistics */
  stats: ProcessingStats;
  /** Model metadata */
  metadata: ModelMetadata;
  /**
   * 2D symbol data (`IfcAnnotation` + `IfcGrid`) from the stream's `complete`
   * event. Omitted when the model has no 2D symbols.
   */
  symbolic_data?: SymbolicData;
}
