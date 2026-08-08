/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc_model_loaded` payload contract (#2385).
 *
 * This event is the project's field perf truth and a regression alert reads it,
 * so the two diagnostic fields added for #2385/#2388 have to arrive intact —
 * including their falsy values, which carry the meaning that matters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelLoadedPayload, type ModelLoadedInputs } from './loadTelemetry.js';

function inputs(over: Partial<ModelLoadedInputs> = {}): ModelLoadedInputs {
  return {
    format: 'ifc',
    fileSizeMB: 76.7312,
    loadTarget: 'primary',
    loadPath: 'wasm',
    meshCount: 6668,
    totalElapsedMs: 32994.4,
    totalVertices: 12905776,
    totalTriangles: 4423296,
    fileReadMs: 563.7,
    metadataCompleteMs: 4984.2,
    firstGeometryBatchMs: 15064.6,
    firstVisibleGeometryMs: 15376.1,
    streamCompleteMs: 32508.9,
    totalCsgFailures: 3,
    wasHidden: false,
    ...over,
  };
}

test('#2385 was_hidden: false survives to the wire', () => {
  const p = buildModelLoadedPayload(inputs({ wasHidden: false }));
  assert.ok('was_hidden' in p, 'a clean load must SAY it is clean');
  assert.equal(p.was_hidden, false);
  // Dropping it would make a clean load indistinguishable from an old client
  // that never reported the field, i.e. from an unfilterable row.
  assert.notEqual(p.was_hidden, undefined);
});

test('#2385 was_hidden: true is reported for a load that spanned a tab switch', () => {
  assert.equal(buildModelLoadedPayload(inputs({ wasHidden: true })).was_hidden, true);
});

test('#2388 total_csg_failures: 0 survives, and is distinct from "cannot tell you"', () => {
  const clean = buildModelLoadedPayload(inputs({ totalCsgFailures: 0 }));
  assert.ok('total_csg_failures' in clean, '0 is a measurement, not an absence');
  assert.equal(clean.total_csg_failures, 0);

  // null = the engine reported no diagnostics at all (older wasm). That must
  // be OMITTED, not coerced to 0 — conflating them would answer the question
  // this field exists to settle with a fabricated zero.
  const unknown = buildModelLoadedPayload(inputs({ totalCsgFailures: null }));
  assert.equal(unknown.total_csg_failures, undefined);
});

test('#2385 a nonzero CSG failure count is carried through unrounded', () => {
  assert.equal(buildModelLoadedPayload(inputs({ totalCsgFailures: 3 })).total_csg_failures, 3);
});

test('#2385 an unreached milestone is omitted, not sent as null or 0', () => {
  const p = buildModelLoadedPayload(inputs({
    metadataCompleteMs: null,
    firstGeometryBatchMs: null,
    firstVisibleGeometryMs: null,
    streamCompleteMs: null,
  }));
  for (const k of [
    'metadata_complete_ms',
    'first_geometry_batch_ms',
    'first_visible_geometry_ms',
    'stream_complete_ms',
  ]) {
    assert.equal(p[k], undefined, `${k} must be omitted when not measured`);
  }
});

test('#2385 a milestone of 0 is a real measurement and is kept', () => {
  // The valid-but-falsy boundary: `value != null` keeps 0, `value ? ... :` loses it.
  const p = buildModelLoadedPayload(inputs({ metadataCompleteMs: 0, streamCompleteMs: 0 }));
  assert.equal(p.metadata_complete_ms, 0);
  assert.equal(p.stream_complete_ms, 0);
});

test('#2385 timings are rounded and file size keeps 2dp (the fingerprint key)', () => {
  const p = buildModelLoadedPayload(inputs());
  assert.equal(p.total_elapsed_ms, 32994);
  assert.equal(p.stream_complete_ms, 32509);
  assert.equal(p.file_read_ms, 564);
  // file_size_mb + mesh_count IS the model fingerprint the alert groups on, so
  // its precision is a compatibility contract, not a formatting choice.
  assert.equal(p.file_size_mb, 76.73);
  assert.equal(p.mesh_count, 6668);
});
