/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The query string every parse-family request carries.
 *
 * Its own module because it encodes a SAFETY contract, not just formatting.
 * `flatLayout` opts this client in to the server's shared-shape flat Parquet
 * layout (issue #3888): the server produces the older layout unless asked,
 * because the shared one renders wrong on a decoder that ignores its
 * `rot0..rot8` columns and the flat wire has no version marker such a decoder
 * could reject. This version's decoder applies them, so it opts in.
 *
 * The two layouts are cached under separate server-side keys, which is why the
 * signal has to go on EVERY endpoint touching that cache — both parse routes,
 * the cache check and the cached-geometry fetch. One that forgets it asks about
 * the other entry. Pinned by `parquet-layout-signal.test.ts`.
 *
 * The streaming route takes one more opt-in, `stream_shapes=cross-batch`
 * (issue #5407), for the same reason one level down: with it a batch's mesh
 * rows may point at vertices an EARLIER batch carried, which a client decoding
 * each batch on its own would read out of range. This version's stream reader
 * keeps earlier batches' shapes, so it opts in; see `parquetStreamQuery`.
 */

import type { ParseRequestOptions } from './client.js';

export function parseQuery(
  options?: ParseRequestOptions,
  flatLayout = false,
  sha256?: string,
  crossBatchShapes = false
): string {
  const params = new URLSearchParams();
  if (options?.tessellationQuality && options.tessellationQuality !== 'medium') {
    params.set('tessellation_quality', options.tessellationQuality);
  }
  if (flatLayout) {
    params.set('parquet_layout', 'shared-shapes');
  }
  // The hash-only stream probe (#3901). It belongs here, beside the rest of the
  // cache identity, because the entry it names is the one THIS query selects:
  // a hash paired with the wrong layout or quality asks about a different blob.
  if (sha256) {
    params.set('sha256', sha256);
  }
  if (crossBatchShapes) {
    params.set('stream_shapes', 'cross-batch');
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * The query of both `POST /api/v1/parse/parquet-stream` requests, the hash
 * probe and the upload: the shared-shape layout plus cross-batch sharing. Only
 * that route reads `stream_shapes`, and it is not part of the cache identity,
 * so the probe and the upload must agree on it only because they must agree on
 * how the answer is decoded.
 */
export function parquetStreamQuery(options?: ParseRequestOptions, sha256?: string): string {
  return parseQuery(options, true, sha256, true);
}
