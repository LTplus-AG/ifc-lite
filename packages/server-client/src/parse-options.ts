/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-request options of the parse endpoints, split out of `client.ts` (which
 * re-exports them) when #6034 added `dataModelEntities`.
 */

/**
 * Per-request parse options shared by all parse endpoints.
 */
export interface ParseRequestOptions {
  /** Abort the request and response stream before the client's timeout. */
  signal?: AbortSignal;

  /**
   * Decode a batch's flat meshes into a few shared buffers (at most 64 MiB each) instead of three
   * buffers per mesh. Omitted = `false`: every mesh owns its `positions`, `normals` and `indices`
   * buffers, as before.
   *
   * With `true`, each mesh array is a view (`subarray`) into its batch's buffers. That turns
   * ~825k ArrayBuffers for a 275k-mesh model into a handful, which keeps the browser from running a
   * full garbage collection for every few dozen MiB decoded (a federation slot loaded beside
   * other models spent most of its time in those collections). In return:
   * - never transfer one mesh's buffer (`postMessage(m, [m.positions.buffer])`): that detaches the
   *   arrays of every other mesh in its batch; copy the array first (`m.positions.slice()`);
   * - `m.positions.buffer` is the batch's buffer, so read it with `byteOffset`/`byteLength`;
   * - one retained mesh keeps its whole batch buffer (up to 64 MiB per array kind) alive.
   * Affects the flat layouts only (`parseParquet`, `parseParquetStream`); the optimized layout is unchanged.
   */
  sharedBuffers?: boolean;

  /**
   * Tessellation detail level (#976). Omitted = `'medium'`, which is
   * byte-identical to the historical output — and to what the wasm path
   * produces without `setTessellationQuality`, so client-side and
   * server-side meshes stay in parity. Non-default levels get distinct
   * server cache entries.
   */
  tessellationQuality?: 'lowest' | 'low' | 'medium' | 'high' | 'highest';
  /**
   * Which rows the data model's entities table carries (#6034). Omitted =
   * `'all'`: every STEP instance in the file, as before.
   *
   * `'rooted'` keeps only the objects (`IfcRoot` subtypes, the rows with a
   * GlobalId) plus every non-rooted instance another data-model table
   * references by id (materials, material sets, classification and document
   * references), so no relation dangles. The geometry-and-property plumbing
   * nothing points at (`IfcCartesianPoint`, `IfcFace`, `IfcPropertySingleValue`,
   * ...) is left out; on large models that is most of the table. Property
   * values, quantities, materials and the spatial tree are unaffected.
   *
   * The two variants are separate server cache entries, so pass the SAME value
   * to the parse call and to `IfcServerClient.fetchDataModel`: a rooted
   * parse writes only the rooted table, and fetching without the option asks
   * for the full one.
   */
  dataModelEntities?: 'all' | 'rooted';
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
