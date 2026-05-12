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
  /** Time spent processing geometry (ms) */
  geometry_time_ms: number;
  /** Total processing time (ms) */
  total_time_ms: number;
  /** Whether result was from cache */
  from_cache: boolean;
}

/**
 * Full parse response with all meshes.
 */
export interface ParseResponse {
  /** Cache key for this result (SHA256 of file content) */
  cache_key: string;
  /** All meshes extracted from the IFC file */
  meshes: MeshData[];
  /** Model metadata */
  metadata: ModelMetadata;
  /** Processing statistics */
  stats: ProcessingStats;
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
}
