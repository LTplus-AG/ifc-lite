/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ByteStreamingPrePassResult } from './byte-streaming-prepass-result.js';

/**
 * #5582: how a prepass's `styleFinishes` reaches the batch. The
 * `processGeometryBatch*` signatures carry only `styleIds` + `styleColors`, so
 * the finish goes to the IfcAPI instance separately, via `setStyleFinishes`,
 * before its first batch with that style wire. Optional: an older wasm has
 * neither the method nor the array, and then nothing is sent.
 */
export interface StyleFinishesApi {
  setStyleFinishes?: (styleIds: Uint32Array, styleFinishes: Float32Array) => void;
}

const NO_FINISHES = new Float32Array(0);

/** The finishes array each IfcAPI instance currently holds. */
const appliedFinishes = new WeakMap<object, Float32Array>();

/**
 * Install `styleFinishes` on one IfcAPI instance, once. A repeat with the same
 * array is a no-op: `setStyleFinishes` decodes the whole wire into a map, so
 * re-sending it every batch would redo that decode every batch. A new
 * instance (a recovery re-init) has no entry and gets the call. A missing
 * array is sent as empty only when the instance holds another wire's
 * finishes, so they cannot carry over.
 */
export function applyStyleFinishes(
  api: object,
  styleIds: Uint32Array,
  styleFinishes: Float32Array | undefined,
): void {
  const set = (api as StyleFinishesApi).setStyleFinishes;
  if (typeof set !== 'function') return;
  const next = styleFinishes ?? NO_FINISHES;
  const prev = appliedFinishes.get(api);
  if (prev === next || (prev === undefined && next.length === 0)) return;
  set.call(api, styleIds, next);
  appliedFinishes.set(api, next);
}

/** `buildPrePassOnce`, then hand its finishes to the same instance. */
export function buildPrePassWithFinishes(
  api: { buildPrePassOnce(data: Uint8Array): unknown },
  buffer: Uint8Array,
): ByteStreamingPrePassResult {
  const prePass = api.buildPrePassOnce(buffer) as ByteStreamingPrePassResult;
  applyStyleFinishes(api, prePass.styleIds, prePass.styleFinishes);
  return prePass;
}
