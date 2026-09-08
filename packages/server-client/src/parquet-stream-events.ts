/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading the SSE body of `POST /api/v1/parse/parquet-stream`.
 *
 * Its own module because there are now TWO requests that answer with that
 * stream and they must be consumed identically (issue #3901): the hash-only
 * probe, which sends no file at all and replays from cache, and the multipart
 * upload it falls back to. The server guarantees a hit replays the same events
 * a live parse emits; duplicating this loop per call site is how that
 * guarantee stops being observable on the client.
 */

import { decodeParquetGeometry } from './parquet-decoder.js';
import type {
  ModelMetadata,
  ParquetBatch,
  ParquetStreamEvent,
  ParquetStreamResult,
  ProcessingStats,
  SymbolicData,
} from './types.js';

/**
 * Raised when an SSE parse stream ends with no terminal event.
 *
 * Shared by `parseStream` and the Parquet stream reader below so the two
 * cannot drift apart by an article. The wording has to hold on BOTH paths,
 * which it does: this reader throws on an `error` event at its own
 * `case 'error'`, so it can only reach its `!stats || !metadata` check in the
 * same state `parseStream`'s `!terminated` describes, the stream stopped
 * without ever saying why. Not re-exported from the package index: it is an
 * internal guarantee about two call sites, not part of the published surface.
 */
export const STREAM_ENDED_WITHOUT_TERMINAL_EVENT =
  'Stream ended without a complete event (connection dropped or the server failed mid-parse)';

/**
 * Drain a `parquet-stream` SSE response, decoding each batch and handing it to
 * `onBatch` as it arrives.
 *
 * @param response - An OK response whose body is the SSE stream.
 * @param onBatch - Called once per decoded batch, for immediate rendering.
 * @param startedAt - `performance.now()` at request time, for the timing log.
 */
export async function consumeParquetStream(
  response: Response,
  onBatch: (batch: ParquetBatch) => void,
  startedAt: number,
): Promise<ParquetStreamResult> {
  if (!response.body) {
    throw new Error('No response body for streaming');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cache_key = '';
  let total_meshes = 0;
  let stats: ProcessingStats | null = null;
  let metadata: ModelMetadata | null = null;
  let symbolic_data: SymbolicData | undefined;

  // A thrown 'error' event (or any other exception mid-loop) must not
  // leave the reader locked on `response.body` — mirrors the try/finally
  // `parseStream` already uses for the same SSE-reading shape.
  try {
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

            case 'complete': {
              stats = event.stats;
              metadata = event.metadata;
              symbolic_data = event.symbolic_data;
              const totalTime = performance.now() - startedAt;
              console.log(`[client] Stream complete: ${total_meshes} meshes in ${totalTime.toFixed(0)}ms`);
              break;
            }

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
  } finally {
    reader.releaseLock();
  }

  if (!stats || !metadata) {
    throw new Error(STREAM_ENDED_WITHOUT_TERMINAL_EVENT);
  }

  return {
    cache_key,
    total_meshes,
    stats,
    metadata,
    symbolic_data,
  };
}
