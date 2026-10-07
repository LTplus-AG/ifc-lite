/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure planning helpers of the parallel pipeline (moved out of
 * `geometry-parallel.ts`, which re-exports them): the pre-pass class-byte span
 * lists and content-affinity job routing.
 */

/**
 * Prepass class-byte layout, mirroring the `PREPASS_CLASS_*` definitions in
 * `rust/processing/src/shard_classes.rs` (the source of truth — these are
 * pinned to it by `prepass-class-spans.test.ts`).
 *
 * The producer packs a named code in the LOW bits and composes FLAG bits on
 * top (`PREPASS_CLASS_FLAG_GEOMETRY_JOB` 0x80, `..._FLAG_TYPE_CANDIDATE`
 * 0x40), so a consumer must mask before comparing — the Rust consumer does
 * (`gpu_meshes/prepass_discovery.rs`), and so does {@link extractPrepassSpanLists}.
 */
export const PREPASS_CLASS_CODE_MASK = 0x3f;
/** `IFCSTYLEDITEM`. */
export const PREPASS_CLASS_STYLED_ITEM = 4;
/** `IFCINDEXEDCOLOURMAP`. */
export const PREPASS_CLASS_INDEXED_COLOUR_MAP = 5;
/** `IFCMATERIALDEFINITIONREPRESENTATION`. */
export const PREPASS_CLASS_MATERIAL_DEF_REPR = 6;
/** `IFCRELASSOCIATESMATERIAL`. */
export const PREPASS_CLASS_REL_ASSOCIATES_MATERIAL = 7;
/** `IFCRELVOIDSELEMENT`. */
export const PREPASS_CLASS_REL_VOIDS = 8;
/** `IFCRELFILLSELEMENT`. */
export const PREPASS_CLASS_REL_FILLS = 9;
/** `IFCRELAGGREGATES`. */
export const PREPASS_CLASS_REL_AGGREGATES = 10;

/** The classes the host builds span lists for (every other code is ignored). */
const HOST_SPAN_CLASSES = [
  PREPASS_CLASS_STYLED_ITEM,
  PREPASS_CLASS_INDEXED_COLOUR_MAP,
  PREPASS_CLASS_MATERIAL_DEF_REPR,
  PREPASS_CLASS_REL_ASSOCIATES_MATERIAL,
  PREPASS_CLASS_REL_VOIDS,
  PREPASS_CLASS_REL_FILLS,
  PREPASS_CLASS_REL_AGGREGATES,
] as const;

/**
 * Build one `(id, start, length)` span list per host-consumed prepass class
 * from the stitched shard columns, in FILE ORDER. Every comparison goes
 * through {@link PREPASS_CLASS_CODE_MASK}, so a record that carries a flag bit
 * alongside its named code still lands in its list instead of being dropped.
 * Returns exact-size arrays (one entry per class in `HOST_SPAN_CLASSES`,
 * empty when the file has none).
 */
export function extractPrepassSpanLists(
  classes: Uint8Array,
  ids: Uint32Array,
  starts: Uint32Array,
  lengths: Uint32Array,
): Map<number, Uint32Array> {
  // Sized by the code mask rather than by the highest class the host consumes:
  // a masked code is always < 64, so a class added on the Rust side cannot
  // write out of bounds here (typed arrays discard such writes silently).
  const counts = new Uint32Array(PREPASS_CLASS_CODE_MASK + 1);
  for (let i = 0; i < classes.length; i++) counts[classes[i] & PREPASS_CLASS_CODE_MASK]++;
  const slots = new Map<number, { arr: Uint32Array; w: number }>();
  for (const k of HOST_SPAN_CLASSES) slots.set(k, { arr: new Uint32Array(counts[k] * 3), w: 0 });
  for (let i = 0; i < classes.length; i++) {
    const slot = slots.get(classes[i] & PREPASS_CLASS_CODE_MASK);
    if (!slot) continue;
    slot.arr[slot.w] = ids[i];
    slot.arr[slot.w + 1] = starts[i];
    slot.arr[slot.w + 2] = lengths[i];
    slot.w += 3;
  }
  const spans = new Map<number, Uint32Array>();
  for (const [k, slot] of slots) spans.set(k, slot.arr);
  return spans;
}

/**
 * Plan content-affinity routing for one chunk: assign each job (by index) to a
 * worker bucket so that every job sharing an affinity key lands on the SAME
 * worker — across the whole stream, since `keyToWorker` is the caller's sticky
 * map. New keys are handed out round-robin from `startWorker`, so each worker
 * owns roughly `1/workerCount` of the distinct keys (≈ distinct geometries, the
 * dominant meshing cost). Pure: mutates only the passed `keyToWorker` and returns
 * the advanced round-robin cursor. (#1130 follow-up — see `affinity_key` in Rust.)
 */
export function planAffinityRouting(
  affinity: Uint32Array,
  totalJobs: number,
  workerCount: number,
  keyToWorker: Map<number, number>,
  startWorker: number,
): { buckets: number[][]; nextWorker: number } {
  const buckets: number[][] = Array.from({ length: workerCount }, () => []);
  let nextWorker = startWorker % workerCount;
  for (let j = 0; j < totalJobs; j++) {
    const key = affinity[j];
    let w = keyToWorker.get(key);
    if (w === undefined) {
      w = nextWorker;
      nextWorker = (nextWorker + 1) % workerCount;
      keyToWorker.set(key, w);
    }
    buckets[w].push(j);
  }
  return { buckets, nextWorker };
}
