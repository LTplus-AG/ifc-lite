// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  ErrorResponse,
  HealthResponse,
  MetadataResponse,
  ModelMetadata,
  OptimizedParquetMetadataHeader,
  OptimizedParquetParseResponse,
  ParquetBatch,
  ParquetMetadataHeader,
  ParquetParseResponse,
  ParquetStreamEvent,
  ParquetStreamResult,
  ParseResponse,
  ProcessingStats,
  ServerConfig,
  StreamEvent,
} from './types.js';
import { decodeParquetGeometry, decodeOptimizedParquetGeometry, isParquetAvailable } from './parquet-decoder.js';

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
export class IfcServerClient {
  private baseUrl: string;
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
  async parse(file: File | ArrayBuffer): Promise<ParseResponse> {
    // Compress file before upload for faster transfer
    const compressedFile = await compressGzip(file);
    const fileName = file instanceof File ? file.name : 'model.ifc';

    const formData = new FormData();
    formData.append('file', compressedFile, fileName);

    const response = await fetch(`${this.baseUrl}/api/v1/parse`, {
      method: 'POST',
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
  async parseParquet(file: File | ArrayBuffer): Promise<ParquetParseResponse> {
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
    const cacheCheck = await fetch(`${this.baseUrl}/api/v1/cache/check/${hash}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000), // 5s timeout for cache check
    });
    const cacheCheckTime = performance.now() - cacheCheckStart;

    if (cacheCheck.ok) {
      // Cache HIT - fetch directly without uploading!
      console.log(`[client] Cache HIT (check: ${cacheCheckTime.toFixed(0)}ms) - skipping upload`);
      return this.fetchCachedGeometry(hash);
    }

    // Cache MISS - upload and process as usual
    console.log(`[client] Cache MISS (check: ${cacheCheckTime.toFixed(0)}ms) - uploading file`);
    return this.uploadAndProcessParquet(file, hash);
  }

  /**
   * Parse IFC file with streaming Parquet response for progressive rendering.
   * 
   * Returns an async generator that yields geometry batches as they're processed.
   * Use this for large files (>50MB) to show geometry progressively.
   * 
   * After streaming completes, fetch the data model via `fetchDataModel(cacheKey)`.
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
    onBatch: (batch: ParquetBatch) => void
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

    // Step 1: Compute hash and check cache first (even for streaming)
    const hashStart = performance.now();
    const hash = await computeFileHash(file);
    const hashTime = performance.now() - hashStart;
    console.log(`[client] Stream: computed hash in ${hashTime.toFixed(0)}ms: ${hash.substring(0, 16)}...`);

    // Step 2: Check if already cached
    const cacheCheckStart = performance.now();
    const cacheCheck = await fetch(`${this.baseUrl}/api/v1/cache/check/${hash}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    const cacheCheckTime = performance.now() - cacheCheckStart;

    if (cacheCheck.ok) {
      // CACHE HIT - fetch all geometry at once (much faster than re-parsing)
      console.log(`[client] Stream: Cache HIT (check: ${cacheCheckTime.toFixed(0)}ms) - fetching cached geometry`);

      const cachedResult = await this.fetchCachedGeometry(hash);

      // Send all meshes as a single batch to the callback
      const decodeStart = performance.now();
      onBatch({
        meshes: cachedResult.meshes,
        batch_number: 1,
        decode_time_ms: performance.now() - decodeStart,
      });

      return {
        cache_key: cachedResult.cache_key,
        total_meshes: cachedResult.meshes.length,
        stats: cachedResult.stats,
        metadata: cachedResult.metadata,
      };
    }

    // CACHE MISS - use streaming for progressive rendering
    console.log(`[client] Stream: Cache MISS (check: ${cacheCheckTime.toFixed(0)}ms) - starting stream for ${fileName} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);

    const formData = new FormData();
    formData.append('file', file instanceof File ? file : new Blob([file]), fileName);

    const uploadStart = performance.now();
    const response = await fetch(`${this.baseUrl}/api/v1/parse/parquet-stream`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw await this.handleError(response);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let cache_key = '';
    let total_meshes = 0;
    let stats: ProcessingStats | null = null;
    let metadata: ModelMetadata | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;

        try {
          const event: ParquetStreamEvent = JSON.parse(jsonStr);

          switch (event.type) {
            case 'start':
              cache_key = event.cache_key;
              console.log(`[client] Stream started: ${event.total_estimate} entities, cache_key: ${cache_key.substring(0, 16)}...`);
              break;

            case 'progress':
              // Progress events can be used for UI feedback
              break;

            case 'batch': {
              const decodeStart = performance.now();
              // Decode base64 Parquet data
              const binaryStr = atob(event.data);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }

              // Decode Parquet to meshes
              const meshes = await decodeParquetGeometry(bytes.buffer);
              const decodeTime = performance.now() - decodeStart;

              total_meshes += meshes.length;
              console.log(`[client] Batch #${event.batch_number}: ${meshes.length} meshes, decode: ${decodeTime.toFixed(0)}ms`);

              // Call the batch callback for immediate rendering
              onBatch({
                meshes,
                batch_number: event.batch_number,
                decode_time_ms: decodeTime,
              });
              break;
            }

            case 'complete':
              stats = event.stats;
              metadata = event.metadata;
              const totalTime = performance.now() - uploadStart;
              console.log(`[client] Stream complete: ${total_meshes} meshes in ${totalTime.toFixed(0)}ms`);
              break;

            case 'error':
              throw new Error(`Stream error: ${event.message}`);
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            console.warn('[client] Failed to parse SSE event:', jsonStr);
          } else {
            throw e;
          }
        }
      }
    }

    if (!stats || !metadata) {
      throw new Error('Stream ended without complete event');
    }

    return {
      cache_key,
      total_meshes,
      stats,
      metadata,
    };
  }

  /**
   * Fetch cached geometry directly without uploading the file.
   * @private
   */
  private async fetchCachedGeometry(hash: string): Promise<ParquetParseResponse> {
    const fetchStart = performance.now();
    const response = await fetch(`${this.baseUrl}/api/v1/cache/geometry/${hash}`, {
      method: 'GET',
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
  private async uploadAndProcessParquet(file: File | ArrayBuffer, hash: string): Promise<ParquetParseResponse> {
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
    const response = await fetch(`${this.baseUrl}/api/v1/parse/parquet`, {
      method: 'POST',
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

    // Verify hash matches (sanity check)
    if (metadata.cache_key !== hash) {
      console.warn(`[client] Cache key mismatch: expected ${hash.substring(0, 16)}..., got ${metadata.cache_key.substring(0, 16)}...`);
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

      // Extract data model if present
      if (offset < payloadBuffer.byteLength) {
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
  async parseParquetOptimized(file: File | ArrayBuffer): Promise<OptimizedParquetParseResponse> {
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

    const response = await fetch(`${this.baseUrl}/api/v1/parse/parquet/optimized`, {
      method: 'POST',
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
  async *parseStream(file: File | ArrayBuffer): AsyncGenerator<StreamEvent> {
    const formData = new FormData();
    const blob = file instanceof File ? file : new Blob([file], { type: 'application/octet-stream' });
    formData.append(
      'file',
      blob,
      file instanceof File ? file.name : 'model.ifc'
    );

    const response = await fetch(`${this.baseUrl}/api/v1/parse/stream`, {
      method: 'POST',
      body: formData,
      // Don't set Content-Type header - browser will set it with boundary for FormData
      headers: {
        Accept: 'text/event-stream',
      },
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6)) as StreamEvent;
              yield data;
            } catch {
              // Skip malformed events
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.startsWith('data: ')) {
        try {
          const data = JSON.parse(buffer.slice(6)) as StreamEvent;
          yield data;
        } catch {
          // Skip malformed events
        }
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
