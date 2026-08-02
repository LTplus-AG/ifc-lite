/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ground-truth regeneration for the World Gym Benchmark.
 *
 * Ground truth is never stored: it is recomputed from the seed on every
 * scoring run via the same `generateModel()` the corpus factory uses.
 * The three tasks read three different label sources, none of which involve
 * running any checker (so no checker bug can leak into the answer key):
 *
 * - defect-detection truth = the corruption layer's plant-time records
 *   (`model.defects`), i.e. exactly what was planted, not what any pipeline
 *   detected.
 * - quantity-estimation truth = the generation-parameter totals
 *   (`model.labels.totals`), i.e. the exact numbers used to author the
 *   geometry. Deleting quantity bindings from the file (the
 *   `missing-quantities` defect) does not change the truth - the geometry
 *   still has those volumes; a submission that meshes the file can recover
 *   them.
 * - validity-triage truth = the number of DISTINCT planted defect types
 *   (0 for clean models, 1-3 for corrupted ones) - an ordinal severity.
 *
 * `groundTruthForSeed` intentionally does not expose the model bytes; use
 * `../generator.mjs` directly when a baseline also needs the content.
 */

import { generateModel } from '../generator.mjs';
import { CORRUPT_RATE, FAMILY, DEFECT_TYPES, QUANTITY_KEYS } from './splits.mjs';

/** Map plant records to the canonical per-type boolean verdict object. */
export function defectTruthFromModel(model) {
  // Records flagged skipped were planned but never applied to the bytes.
  const planted = new Set((model.defects ?? []).filter((d) => !d.skipped).map((d) => d.type));
  const truth = {};
  for (const type of DEFECT_TYPES) truth[type] = planted.has(type);
  return truth;
}

/** Canonical quantity-truth object: every key present, absent totals as 0. */
export function quantityTruthFromModel(model) {
  const totals = model.labels?.totals ?? {};
  const truth = {};
  for (const key of QUANTITY_KEYS) {
    const v = totals[key];
    truth[key] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  return truth;
}

/** Ordinal severity: distinct planted defect types (0..3). */
export function severityFromModel(model) {
  return new Set((model.defects ?? []).filter((d) => !d.skipped).map((d) => d.type)).size;
}

/**
 * Regenerate the full benchmark ground truth for one seed. ~1-15 ms per
 * seed (pure generation, no checks, no geometry).
 */
export function groundTruthForSeed(seed) {
  const model = generateModel(seed, FAMILY, { corruptRate: CORRUPT_RATE });
  return {
    seed,
    family: model.family,
    corrupted: model.corrupted,
    defects: defectTruthFromModel(model),
    quantities: quantityTruthFromModel(model),
    severity: severityFromModel(model),
  };
}
