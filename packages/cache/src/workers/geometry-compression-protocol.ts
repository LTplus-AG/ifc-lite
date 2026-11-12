/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface CompressionRequest { id: number; buffer: ArrayBuffer }
/** Inflate one stored deflate-raw chunk off the main thread (cache hits); the reply is the raw chunk record. */
export interface InflateRequest { id: number; op: 'inflate'; buffer: ArrayBuffer }
/** Inflate (when `compressed`) and decode one stored chunk into meshes (cache hits; the reply transfers the mesh arrays). */
export interface DecodeRequest {
  id: number; op: 'decode'; buffer: ArrayBuffer; compressed: boolean;
  rawLength: number; meshCount: number; version: number;
  /** The section's appearance-source pool; replies refer to its arrays by index. Sent once per worker: */
  pool?: Uint32Array[];
  /** ...later requests set this instead and the worker reuses the pool it was sent. */
  samePool?: true;
}
export type CompressionResponse =
  | { id: number; buffer: ArrayBuffer; compressed: boolean }
  | { id: number; meshes: unknown[]; poolRefs: Int32Array }
  | { id: number; error: string };

export function isCompressionRequest(value: unknown): value is CompressionRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<CompressionRequest> & { op?: unknown };
  return request.op === undefined && Number.isSafeInteger(request.id) && request.id! > 0 && request.buffer instanceof ArrayBuffer;
}

export function isInflateRequest(value: unknown): value is InflateRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<InflateRequest>;
  return request.op === 'inflate' && Number.isSafeInteger(request.id) && request.id! > 0 && request.buffer instanceof ArrayBuffer;
}

export function isDecodeRequest(value: unknown): value is DecodeRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DecodeRequest>;
  return request.op === 'decode' && Number.isSafeInteger(request.id) && request.id! > 0 && request.buffer instanceof ArrayBuffer
    && typeof request.compressed === 'boolean' && Number.isSafeInteger(request.rawLength) && Number.isSafeInteger(request.meshCount)
    && Number.isSafeInteger(request.version) && (request.pool === undefined || Array.isArray(request.pool));
}
