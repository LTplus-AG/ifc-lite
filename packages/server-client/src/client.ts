// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  ErrorResponse,
  HealthResponse,
  MetadataResponse,
  OptimizedParquetMetadataHeader,
  OptimizedParquetParseResponse,
  ParquetBatch,
  ParquetMetadataHeader,
  ParquetParseResponse,
  ParquetStreamResult,
  ParseResponse,
  ServerConfig,
  StreamEvent,
  SymbolicData,
} from './types.js';
import { decodeParquetGeometry, decodeOptimizedParquetGeometry, isParquetAvailable } from './parquet-decoder.js';
import { parseQuery } from './parse-query.js';
import {
  consumeParquetStream,
  STREAM_ENDED_WITHOUT_TERMINAL_EVENT,
} from './parquet-stream-events.js';


/**
 * Compress a file or ArrayBuffer using gzip compression.
 * Uses the browser's CompressionStream API for efficient compression.
 *
 * @param file - File or ArrayBuffer to compress
 * @returns Compressed Blob
 */
async function compressGzip(file: File | ArrayBuffer): Promise<Blob> {
  const stream = file instanceof File ? file.stream() : new Blob([file]).stream();
  const compressionStream = new CompressionStream('gzip');
  const compressedStream = stream.pipeThrough(compressionStream);
  return new Response(compressedStream).blob();
}

/**
 * Compute SHA-256 hash of a file or ArrayBuffer.
 * Used for cache key generation client-side to avoid uploading files that are already cached.
 *
 * @param file - File or ArrayBuffer to hash
 * @returns Hexadecimal SHA-256 hash string
 */
async function computeFileHash(file: File | ArrayBuffer): Promise<string> {
  const buffer = file instanceof File ? await file.arrayBuffer() : file;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Client for the IFC-Lite Server API.
 *
 * @example
 * ```typescript
 * const client = new IfcServerClient({
 *   baseUrl: 'https://ifc-lite.railway.app'
 * });
 *
 * // Check server health
 * const health = await client.health();
 * console.log(health.status);
 *
 * // Parse IFC file
 * const result = await client.parse(file);
 * console.log(`Meshes: ${result.meshes.length}`);
 * ```
 */
/**
 * Per-request parse options shared by all parse endpoints.
 */
export interface ParseRequestOptions {
  /**
   * Tessellation detail level (#976). Omitted = `'medium'`, which is
   * byte-identical to the historical output — and to what the wasm path
   * produces without `setTessellationQuality`, so client-side and
   * server-side meshes stay in parity. Non-default levels get distinct
   * server cache entries.
   */
  tessellationQuality?: 'lowest' | 'low' | 'medium' | 'high' | 'highest';
}

/**
 * Options for {@link IfcServerClient.parseParquetStream}.
 */
export interface ParseStreamOptions extends ParseRequestOptions {
  /**
   * Skip the hash-only cache probe and upload straight away (#3901).
   *
   * The probe costs one round trip plus a local SHA-256 of the file, and saves
   * the entire upload when the server already has the model. Turn it off when
   * you know the server is cold, or when hashing locally is the expensive part
   * (a very large file behind a fast link).
   */
  skipCacheProbe?: boolean;
}

/** Build the query string shared by the parse endpoints. */
export class IfcServerClient {
  private baseUrl: string;
  private readonly token?: string;
  private timeout: number;

  /**
   * Create a new IFC server client.
   *
   * @param config - Client configuration
   */
  constructor(config: ServerConfig) {
    // Remove trailing slash from base URL
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 300000; // 5 minutes default
    this.token = config.token;
  }
  /**
   * Authorization header for servers running with `IFC_SERVER_API_TOKEN`.
   * Empty when no token is configured, so open servers see no change.
   */
  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return this.token
      ? { Authorization: `Bearer ${this.token}`, ...extra }
      : { ...(extra ?? {}) };
  }


  /**
   * Check server health.
   *
   * @returns Health status
   */
  async health(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    return response.json();
  }

  /**
   * Parse IFC file and return all geometry.
   *
   * For large files (>10MB), consider using `parseStream()` instead
   * to receive progressive updates.
   *
   * @param file - File or ArrayBuffer containing IFC data
   * @returns Parse result with all meshes
   *
   * @example
   * ```typescript
   * const result = await client.parse(file);
   * for (const mesh of result.meshes) {
   *   scene.add(createMesh(mesh.positions, mesh.indices, mesh.color));
   * }
   * ```
   */
  async parse(file: File | ArrayBuffer, options?: ParseRequestOptions): Promise<ParseResponse> {
    // Compress file before upload for faster transfer
    const compressedFile = await compressGzip(file);
    const fileName = file instanceof File ? file.name : 'model.ifc';

    const formData = new FormData();
    formData.append('file', compressedFile, fileName);

    const response = await fetch(`${this.baseUrl}/api/v1/parse${parseQuery(options)}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    return response.json();
  }

  /**
   * Parse IFC file and return geometry in Parquet format.
   *
   * This method provides ~15x smaller payload size compared to JSON,
   * which is critical for large IFC files over network connections.
   *
   * **Cache-aware:** Computes file hash client-side and checks cache before uploading.
   * If cached, skips upload entirely for much faster response.
   *
   * **Requirements:** This method requires `parquet-wasm` and `apache-arrow`
   * to be installed as peer dependencies.
   *
   * @param file - File or ArrayBuffer containing IFC data
   * @returns Parse result with all meshes (decoded from Parquet)
   *
   * @example
   * ```typescript
   * const result = await client.parseParquet(file);
   * console.log(`Payload: ${result.parquet_stats.payload_size} bytes`);
   * console.log(`Decode time: ${result.parquet_stats.decode_time_ms}ms`);
   * for (const mesh of result.meshes) {
   *   scene.add(createMesh(mesh.positions, mesh.indices, mesh.color));
   * }
   * ```
   */
  async parseParquet(file: File | ArrayBuffer, options?: ParseRequestOptions): Promise<ParquetParseResponse> {
    // Check if Parquet decoding is available
    const parquetReady = await isParquetAvailable();
    if (!parquetReady) {
      throw new Error(
        'Parquet parsing requires parquet-wasm and apache-arrow. ' +
        'Install them with: npm install parquet-wasm apache-arrow'
      );
    }

    // Step 1: Compute hash client-side (fast, ~50ms for large files)
    const hashStart = performance.now();
    const hash = await computeFileHash(file);
    const hashTime = performance.now() - hashStart;
    console.log(`[client] Computed file hash in ${hashTime.toFixed(0)}ms: ${hash.substring(0, 16)}...`);

    // Step 2: Check if already cached
    const cacheCheckStart = performance.now();
    const cacheCheck = await fetch(`${this.baseUrl}/api/v1/cache/check/${hash}${parseQuery(options, true)}`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(5000), // 5s timeout for cache check
    });
    const cacheCheckTime = performance.now() - cacheCheckStart;

    if (cacheCheck.ok) {
      // Cache HIT - fetch directly without uploading!
      console.log(`[client] Cache HIT (check: ${cacheCheckTime.toFixed(0)}ms) - skipping upload`);
      return this.fetchCachedGeometry(hash, options);
    }

    // Cache MISS - upload and process as usual
    console.log(`[client] Cache MISS (check: ${cacheCheckTime.toFixed(0)}ms) - uploading file`);
    return this.uploadAndProcessParquet(file, hash, options);
  }

  /**
   * Parse IFC file with streaming Parquet response for progressive rendering.
   *
   * Returns an async generator that yields geometry batches as they're processed.
   * Use this for large files (>50MB) to show geometry progressively.
   *
   * After streaming completes, fetch the data model via `fetchDataModel(cacheKey)`.
   *
   * **Cache-aware, without paying the upload.** The file is hashed locally and
   * the hash is presented to `/parse/parquet-stream` on its own, with no body
   * (issue #3901). A warm server replays the cached stream immediately; a cold
   * one answers `404` and this method uploads. Either way the SSE events are
   * read by the same code, so a hit and a miss render identically.
   *
   * The probe replaced a two-request `cache/check` + `cache/geometry` dance
   * that fetched the whole model as ONE batch on a hit, i.e. no progressive
   * rendering exactly when the data was already there. Set
   * `skipCacheProbe: true` to go straight to the upload.
   *
   * @param file - IFC file to parse (File or ArrayBuffer)
   * @param onBatch - Callback for each geometry batch (for immediate rendering)
   * @returns Final result with cache_key, stats, and metadata
   *
   * @example
   * ```typescript
   * const result = await client.parseParquetStream(file, (batch) => {
   *   // Render each batch immediately
   *   for (const mesh of batch.meshes) {
   *     scene.add(createMesh(mesh));
   *   }
   * });
   *
   * // After geometry is complete, fetch data model for properties panel
   * const dataModel = await client.fetchDataModel(result.cache_key);
   * ```
   */
  async parseParquetStream(
    file: File | ArrayBuffer,
    onBatch: (batch: ParquetBatch) => void,
    options?: ParseStreamOptions
  ): Promise<ParquetStreamResult> {
    const parquetReady = await isParquetAvailable();
    if (!parquetReady) {
      throw new Error(
        'Parquet streaming requires parquet-wasm and apache-arrow. ' +
        'Install them with: npm install parquet-wasm apache-arrow'
      );
    }

    const fileSize = file instanceof File ? file.size : file.byteLength;
    const fileName = file instanceof File ? file.name : 'model.ifc';

    if (!options?.skipCacheProbe) {
      // Hash locally and ask by hash. On a hit this is the WHOLE request: the
      // 40 MB the upload would have cost never leaves the machine.
      const hashStart = performance.now();
      const hash = await computeFileHash(file);
      console.log(`[client] Stream: computed hash in ${(performance.now() - hashStart).toFixed(0)}ms: ${hash.substring(0, 16)}...`);

      const probeStart = performance.now();
      const probe = await fetch(
        `${this.baseUrl}/api/v1/parse/parquet-stream${parseQuery(options, true, hash)}`,
        {
          method: 'POST',
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(this.timeout),
        }
      );

      if (probe.ok) {
        console.log(`[client] Stream: cache HIT by hash (${(performance.now() - probeStart).toFixed(0)}ms) - replaying without upload`);
        return consumeParquetStream(probe, onBatch, probeStart);
      }

      // 404 is the server's "nothing cached under that hash, send the body".
      // Anything else is a real failure and must surface rather than being
      // retried as a full upload.
      if (probe.status !== 404) {
        throw await this.handleError(probe);
      }
      await probe.body?.cancel();
      console.log(`[client] Stream: cache MISS by hash (${(performance.now() - probeStart).toFixed(0)}ms) - uploading`);
    }

    console.log(`[client] Stream: starting upload for ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    const formData = new FormData();
    formData.append('file', file instanceof File ? file : new Blob([file]), fileName);

    const uploadStart = performance.now();
    const response = await fetch(`${this.baseUrl}/api/v1/parse/parquet-stream${parseQuery(options, true)}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    return consumeParquetStream(response, onBatch, uploadStart);
  }

  /**
   * Fetch cached geometry directly without uploading the file.
   * @private
   */
  private async fetchCachedGeometry(
    hash: string,
    options?: ParseRequestOptions
  ): Promise<ParquetParseResponse> {
    const fetchStart = performance.now();
    const response = await fetch(`${this.baseUrl}/api/v1/cache/geometry/${hash}${parseQuery(options, true)}`, {
      method: 'GET',
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    const fetchTime = performance.now() - fetchStart;
    console.log(`[client] Fetched cached geometry in ${fetchTime.toFixed(0)}ms`);

    // Extract metadata from header
    const metadataHeader = response.headers.get('X-IFC-Metadata');
    if (!metadataHeader) {
      throw new Error('Missing X-IFC-Metadata header in cached geometry response');
    }

    const metadata: ParquetMetadataHeader = JSON.parse(metadataHeader);

    // Get binary payload
    const payloadBuffer = await response.arrayBuffer();
    const payloadSize = payloadBuffer.byteLength;

    // Parse response (same format as upload path)
    return this.parseParquetResponse(payloadBuffer, metadata, payloadSize);
  }

  /**
   * Upload file and process on server.
   * @private
   */
  private async uploadAndProcessParquet(file: File | ArrayBuffer, hash: string, options?: ParseRequestOptions): Promise<ParquetParseResponse> {
    const fileSize = file instanceof File ? file.size : file.byteLength;
    const fileName = file instanceof File ? file.name : 'model.ifc';

    // Skip compression for large files (>50MB) - compression time exceeds transfer savings
    // Also skip for localhost where bandwidth is not a bottleneck
    const isLocalhost = this.baseUrl.includes('localhost') || this.baseUrl.includes('127.0.0.1');
    const skipCompression = fileSize > 50 * 1024 * 1024 || isLocalhost;

    let uploadFile: Blob | File | ArrayBuffer;
    if (skipCompression) {
      console.log(`[client] Skipping compression (file: ${(fileSize / 1024 / 1024).toFixed(1)}MB, localhost: ${isLocalhost})`);
      uploadFile = file instanceof File ? file : new Blob([file]);
    } else {
      const compressStart = performance.now();
      uploadFile = await compressGzip(file);
      console.log(`[client] Compressed in ${(performance.now() - compressStart).toFixed(0)}ms: ${(fileSize / 1024 / 1024).toFixed(1)}MB → ${((uploadFile as Blob).size / 1024 / 1024).toFixed(1)}MB`);
    }

    const formData = new FormData();
    formData.append('file', uploadFile as Blob, fileName);

    const uploadStart = performance.now();
    const response = await fetch(`${this.baseUrl}/api/v1/parse/parquet${parseQuery(options, true)}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });
    const uploadTime = performance.now() - uploadStart;
    console.log(`[client] Upload and processing completed in ${uploadTime.toFixed(0)}ms`);

    if (!response.ok) {
      throw await this.handleError(response);
    }

    // Extract metadata from header
    const metadataHeader = response.headers.get('X-IFC-Metadata');
    if (!metadataHeader) {
      throw new Error('Missing X-IFC-Metadata header in Parquet response');
    }

    const metadata: ParquetMetadataHeader = JSON.parse(metadataHeader);

    // Sanity check: the server cache key is the file hash plus request
    // suffixes (`{hash}-{opening_filter}[-q{level}]`), so verify derivation,
    // not equality — the old equality check warned on every fresh upload.
    if (!metadata.cache_key.startsWith(hash)) {
      console.warn(`[client] Cache key mismatch: expected a key derived from ${hash.substring(0, 16)}..., got ${metadata.cache_key.substring(0, 16)}...`);
    }

    // Get binary payload
    const payloadBuffer = await response.arrayBuffer();
    const payloadSize = payloadBuffer.byteLength;

    // Parse response (same format as cached path)
    return this.parseParquetResponse(payloadBuffer, metadata, payloadSize);
  }

  /**
   * Parse Parquet response payload into meshes.
   * @private
   */
  private async parseParquetResponse(
    payloadBuffer: ArrayBuffer,
    metadata: ParquetMetadataHeader,
    payloadSize: number
  ): Promise<ParquetParseResponse> {
    // Extract geometry and data model from combined Parquet format
    // Format: [geometry_len][geometry_data][data_model_len][data_model_data]
    // Note: geometry_data itself contains [mesh_len][mesh_data][vertex_len][vertex_data][index_len][index_data]
    const view = new DataView(payloadBuffer);
    let offset = 0;

    // Detect format: check if payload starts with length prefix (wrapped format)
    // Even if metadata.data_model_stats is undefined, cached responses use wrapped format
    const firstLen = view.getUint32(0, true);
    const hasWrapper = firstLen > 0 && firstLen < payloadBuffer.byteLength && firstLen < payloadBuffer.byteLength - 4;
    
    let geometryData: ArrayBuffer;
    let dataModelBuffer: ArrayBuffer | undefined;

    if (hasWrapper) {
      // Wrapped format: [geometry_len][geometry_data][data_model_len][data_model_data]
      const geometryLen = firstLen;
      offset += 4;

      // Validate geometry length
      if (geometryLen > payloadBuffer.byteLength || geometryLen === 0 || offset + geometryLen > payloadBuffer.byteLength) {
        throw new Error(`Invalid geometry length: ${geometryLen}, buffer size: ${payloadBuffer.byteLength}, offset: ${offset}`);
      }

      geometryData = payloadBuffer.slice(offset, offset + geometryLen);
      offset += geometryLen;

      // Extract data model if present (need at least 4 bytes for the u32 length prefix)
      if (offset + 4 <= payloadBuffer.byteLength) {
        const dataModelLen = view.getUint32(offset, true);
        offset += 4;
        if (dataModelLen > 0 && offset + dataModelLen <= payloadBuffer.byteLength) {
          dataModelBuffer = payloadBuffer.slice(offset, offset + dataModelLen);
        }
      }
    } else {
      // Old format: geometry Parquet directly (no wrapper)
      console.log('[client] Detected old format (no wrapper), using entire payload as geometry');
      geometryData = payloadBuffer;
      dataModelBuffer = undefined;
    }

    // Decode Parquet geometry
    const decodeStart = performance.now();
    const meshes = await decodeParquetGeometry(geometryData);
    const decodeTime = performance.now() - decodeStart;

    return {
      cache_key: metadata.cache_key,
      meshes,
      mesh_coordinate_space: metadata.mesh_coordinate_space,
      site_transform: metadata.site_transform,
      building_transform: metadata.building_transform,
      metadata: metadata.metadata,
      stats: metadata.stats,
      parquet_stats: {
        payload_size: payloadSize,
        decode_time_ms: Math.round(decodeTime),
      },
      data_model: dataModelBuffer,
    };
  }

  /**
   * Fetch the data model for a previously parsed file.
   * 
   * The data model is processed in the background after geometry is returned.
   * This method polls until the data model is ready (with exponential backoff).
   *
   * @param cacheKey - The cache key from the geometry parse response
   * @param maxRetries - Maximum number of retries (default: 10)
   * @returns Data model Parquet buffer, or null if not available after retries
   *
   * @example
   * ```typescript
   * const geometryResult = await client.parseParquet(file);
   * // Start rendering geometry immediately...
   * 
   * // Then fetch data model in background
   * const dataModelBuffer = await client.fetchDataModel(geometryResult.cache_key);
   * if (dataModelBuffer) {
   *   const dataModel = await decodeDataModel(dataModelBuffer);
   * }
   * ```
   */
  async fetchDataModel(cacheKey: string, maxRetries = 10): Promise<ArrayBuffer | null> {
    let delay = 100; // Start with 100ms delay

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/v1/parse/data-model/${cacheKey}`, {
          method: 'GET',
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(30000),
        });

        if (response.status === 200) {
          // Data model is ready
          const buffer = await response.arrayBuffer();
          console.log(`[client] Data model fetched: ${(buffer.byteLength / 1024 / 1024).toFixed(2)}MB`);
          return buffer;
        } else if (response.status === 202) {
          // Still processing, wait and retry
          console.log(`[client] Data model still processing (attempt ${attempt + 1}/${maxRetries}), waiting ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, 2000); // Exponential backoff, max 2s
        } else if (response.status === 404) {
          // Cache key not found
          console.warn(`[client] Data model not found for cache key: ${cacheKey}`);
          return null;
        } else {
          throw new Error(`Unexpected response status: ${response.status}`);
        }
      } catch (error) {
        if (attempt === maxRetries - 1) {
          console.error('[client] Failed to fetch data model:', error);
          return null;
        }
        // Retry on network errors
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.5, 2000);
      }
    }

    console.warn('[client] Data model fetch timed out after max retries');
    return null;
  }

  /**
   * Fetch the 2D symbol stream (`IfcAnnotation` + `IfcGrid`) for a previously
   * parsed file.
   *
   * The JSON endpoints (`parse`, `parseStream`) and the streaming Parquet path
   * already deliver `symbolic_data` inline. This helper is for the binary
   * Parquet transports (`parseParquet`, `parseParquetOptimized`) whose payloads
   * can't carry it inline — fetch it by the `cache_key` returned in their
   * result, mirroring {@link fetchDataModel}.
   *
   * Symbolic data is cached synchronously by the non-streaming endpoints, so
   * this typically returns on the first attempt; the streaming endpoint caches
   * it in the background, hence the bounded retry.
   *
   * @param cacheKey - The `cache_key` from a parse response
   * @param maxRetries - Maximum number of retries (default: 10)
   * @returns Decoded symbol data, or null if unavailable after retries
   *
   * @example
   * ```typescript
   * const result = await client.parseParquet(file);
   * const symbols = await client.fetchSymbolic(result.cache_key);
   * if (symbols) {
   *   console.log(`${symbols.grid_axes.length} grid axes, ${symbols.texts.length} labels`);
   * }
   * ```
   */
  async fetchSymbolic(cacheKey: string, maxRetries = 10): Promise<SymbolicData | null> {
    let delay = 100; // Start with 100ms delay

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Only transport/timeout failures are retried here. HTTP error statuses
      // are handled below so a persistent 5xx surfaces as a thrown error rather
      // than being collapsed into `null` (which would look like "no symbols").
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/v1/parse/symbolic/${cacheKey}`, {
          method: 'GET',
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(30000),
        });
      } catch (error) {
        if (attempt === maxRetries - 1) throw error;
        console.warn('[client] Retrying symbolic data fetch after network error:', error);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.5, 2000); // Exponential backoff, max 2s
        continue;
      }

      if (response.status === 200) {
        return (await response.json()) as SymbolicData;
      } else if (response.status === 202) {
        // Still processing (streaming background cache), wait and retry.
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.5, 2000);
      } else if (response.status === 404) {
        // Definitive "no entry for this cache key" — distinct from a server error.
        console.warn(`[client] Symbolic data not found for cache key: ${cacheKey}`);
        return null;
      } else {
        // 5xx / other unexpected status: surface it instead of masking it.
        throw await this.handleError(response);
      }
    }

    // Exhausted retries while still 202 (background cache not ready). This is a
    // known "not yet available" state, so return null rather than throwing.
    console.warn('[client] Symbolic data fetch timed out after max retries');
    return null;
  }

  /**
   * Check if Parquet parsing is available.
   *
   * @returns true if parquet-wasm is available for parseParquet()
   */
  async isParquetSupported(): Promise<boolean> {
    return isParquetAvailable();
  }

  /**
   * Parse IFC file using the ara3d BOS-optimized Parquet format.
   *
   * This is the most efficient transfer format, providing:
   * - ~50x smaller payloads compared to JSON
   * - Integer quantized vertices (0.1mm precision)
   * - Mesh deduplication (instancing)
   * - Byte colors instead of floats
   * - Optional normals (computed on client if not included)
   *
   * **Requirements:** Requires `parquet-wasm` and `apache-arrow`.
   *
   * @param file - File or ArrayBuffer containing IFC data
   * @returns Parse result with all meshes (decoded from optimized Parquet)
   *
   * @example
   * ```typescript
   * const result = await client.parseParquetOptimized(file);
   * console.log(`Unique meshes: ${result.optimization_stats.unique_meshes}`);
   * console.log(`Mesh reuse ratio: ${result.optimization_stats.mesh_reuse_ratio}x`);
   * console.log(`Payload: ${result.parquet_stats.payload_size} bytes`);
   * ```
   */
  async parseParquetOptimized(file: File | ArrayBuffer, options?: ParseRequestOptions): Promise<OptimizedParquetParseResponse> {
    // Check if Parquet decoding is available
    const parquetReady = await isParquetAvailable();
    if (!parquetReady) {
      throw new Error(
        'Parquet parsing requires parquet-wasm and apache-arrow. ' +
        'Install them with: npm install parquet-wasm apache-arrow'
      );
    }

    // Compress file before upload for faster transfer
    const compressedFile = await compressGzip(file);
    const fileName = file instanceof File ? file.name : 'model.ifc';

    const formData = new FormData();
    formData.append('file', compressedFile, fileName);

    const response = await fetch(`${this.baseUrl}/api/v1/parse/parquet/optimized${parseQuery(options)}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    // Extract metadata from header
    const metadataHeader = response.headers.get('X-IFC-Metadata');
    if (!metadataHeader) {
      throw new Error('Missing X-IFC-Metadata header in optimized Parquet response');
    }

    const metadata: OptimizedParquetMetadataHeader = JSON.parse(metadataHeader);

    // Get binary payload
    const payloadBuffer = await response.arrayBuffer();
    const payloadSize = payloadBuffer.byteLength;

    // Decode optimized Parquet geometry
    const decodeStart = performance.now();
    const meshes = await decodeOptimizedParquetGeometry(payloadBuffer, metadata.vertex_multiplier);
    const decodeTime = performance.now() - decodeStart;

    return {
      cache_key: metadata.cache_key,
      meshes,
      mesh_coordinate_space: metadata.mesh_coordinate_space,
      site_transform: metadata.site_transform,
      building_transform: metadata.building_transform,
      metadata: metadata.metadata,
      stats: metadata.stats,
      optimization_stats: metadata.optimization_stats,
      parquet_stats: {
        payload_size: payloadSize,
        decode_time_ms: Math.round(decodeTime),
      },
    };
  }

  /**
   * Parse IFC file with streaming response.
   *
   * Yields events as geometry is processed, allowing for
   * progressive rendering of large models.
   *
   * @param file - File or ArrayBuffer containing IFC data
   * @yields Stream events (start, progress, batch, complete, error)
   * @throws If the stream ends without a `complete` or `error` event — a
   *   dropped connection or a server-side failure mid-parse. Breaking out
   *   of the loop early does not trigger this.
   *
   * @example
   * ```typescript
   * for await (const event of client.parseStream(file)) {
   *   switch (event.type) {
   *     case 'start':
   *       console.log(`Processing ~${event.total_estimate} entities`);
   *       break;
   *     case 'progress':
   *       updateProgressBar(event.processed / event.total);
   *       break;
   *     case 'batch':
   *       for (const mesh of event.meshes) {
   *         scene.add(createMesh(mesh));
   *       }
   *       break;
   *     case 'complete':
   *       console.log(`Done in ${event.stats.total_time_ms}ms`);
   *       break;
   *     case 'error':
   *       console.error(event.message);
   *       break;
   *   }
   * }
   * ```
   */
  async *parseStream(
    file: File | ArrayBuffer,
    options?: ParseRequestOptions
  ): AsyncGenerator<StreamEvent> {
    const formData = new FormData();
    const blob = file instanceof File ? file : new Blob([file], { type: 'application/octet-stream' });
    formData.append(
      'file',
      blob,
      file instanceof File ? file.name : 'model.ifc'
    );

    const response = await fetch(`${this.baseUrl}/api/v1/parse/stream${parseQuery(options)}`, {
      method: 'POST',
      body: formData,
      // Don't set Content-Type header - browser will set it with boundary for FormData
      headers: this.authHeaders({ Accept: 'text/event-stream' }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // A stream that stops before `complete`/`error` is a failed parse, not
    // a finished one — the same contract `parseStreamToParquet` enforces.
    let terminated = false;

    // Decode one SSE frame. Returns undefined (and warns) for a frame we
    // cannot parse, so a dropped event is never invisible. The yield must
    // stay outside the try: an error thrown *into* this generator by the
    // consumer surfaces at the yield point and would be swallowed as if it
    // were a malformed frame.
    const decodeFrame = (frame: string): StreamEvent | undefined => {
      if (!frame.startsWith('data: ')) return undefined;
      try {
        return JSON.parse(frame.slice(6)) as StreamEvent;
      } catch (err) {
        console.warn('[client] Skipping malformed SSE event:', frame, err);
        return undefined;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const data = decodeFrame(line);
          if (!data) continue;
          if (data.type === 'complete' || data.type === 'error') terminated = true;
          yield data;
        }
      }

      // Process remaining buffer
      const tail = decodeFrame(buffer);
      if (tail) {
        if (tail.type === 'complete' || tail.type === 'error') terminated = true;
        yield tail;
      }

      if (!terminated) {
        throw new Error(STREAM_ENDED_WITHOUT_TERMINAL_EVENT);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Get quick metadata about an IFC file without processing geometry.
   *
   * This is much faster than a full parse and is useful for
   * showing file information before processing.
   *
   * @param file - File or ArrayBuffer containing IFC data
   * @returns Metadata about the file
   *
   * @example
   * ```typescript
   * const meta = await client.getMetadata(file);
   * console.log(`${meta.entity_count} entities, ${meta.geometry_count} with geometry`);
   * console.log(`Schema: ${meta.schema_version}`);
   * ```
   */
  async getMetadata(file: File | ArrayBuffer): Promise<MetadataResponse> {
    const formData = new FormData();
    formData.append(
      'file',
      file instanceof File ? file : new Blob([file]),
      file instanceof File ? file.name : 'model.ifc'
    );

    const response = await fetch(`${this.baseUrl}/api/v1/parse/metadata`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData,
      signal: AbortSignal.timeout(30000), // 30 second timeout for metadata
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    return response.json();
  }

  /**
   * Retrieve a cached parse result by key.
   *
   * @param key - Cache key (SHA256 hash of file content)
   * @returns Cached parse result, or null if not found
   *
   * @example
   * ```typescript
   * // Store the cache key from a previous parse
   * const result = await client.parse(file);
   * const cacheKey = result.cache_key;
   *
   * // Later, retrieve from cache
   * const cached = await client.getCached(cacheKey);
   * if (cached) {
   *   console.log('Loaded from cache!');
   * }
   * ```
   */
  async getCached(key: string): Promise<ParseResponse | null> {
    const response = await fetch(`${this.baseUrl}/api/v1/cache/${key}`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw await this.handleError(response);
    }

    return response.json();
  }

  /**
   * Handle error responses from the server.
   */
  private async handleError(response: Response): Promise<Error> {
    try {
      const error: ErrorResponse = await response.json();
      return new Error(`Server error (${error.code}): ${error.error}`);
    } catch {
      return new Error(`Server error: ${response.status} ${response.statusText}`);
    }
  }
}
