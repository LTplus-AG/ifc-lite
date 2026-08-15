/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc_model_loaded` payload contract (#2385).
 *
 * This event is the project's field perf truth and a regression alert reads it,
 * so the two diagnostic fields added for #2385/#2388 have to arrive intact —
 * including their falsy values, which carry the meaning that matters.
 *
 * The second half of the file pins the last-load snapshot behind the
 * device-loss report (#2624) - see the `last-load snapshot` describe below.
 */

import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posthog } from '@/lib/analytics';
import {
  buildModelLoadedPayload,
  captureModelLoaded,
  clearModelLoadedSnapshot,
  getModelLoadedSnapshot,
  recordModelLoadedSnapshot,
  resetModelLoadedSnapshotForTests,
  snapshotFromGeometry,
  type ModelLoadedInputs,
} from './loadTelemetry.js';

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

/**
 * The last-load snapshot behind the device-loss report (#2624).
 *
 * The trap these tests pin (found in review on #2643): `useIfcLoader.ts` has
 * SIX completing load paths that capture `ifc_model_loaded` (point-cloud,
 * ifcx, glb, cache-hit, server, local wasm), and originally only the wasm one
 * recorded the snapshot. After a cache-hit or server load - the server path is
 * on by default - the module-level snapshot still held the PREVIOUS model's
 * numbers, so a later GPU loss shipped `last_load_*` fields describing a
 * different model than the one on the device. Stale numbers mislead triage
 * worse than absent ones, which inverts the point of the enrichment.
 *
 * Two halves make that impossible, and each has a test here:
 *  - fail-safe: every primary load CLEARS the snapshot at its start, so a
 *    path that records nothing (or a future seventh path) omits the fields;
 *  - per-path truth: every capture goes through `captureModelLoaded`, whose
 *    mandatory snapshot argument records that path's own numbers.
 * The source sweep keeps both wired inside `useIfcLoader.ts` itself - the
 * unit tests alone would stay green if the loader stopped calling either.
 */
describe('last-load snapshot for the device-loss report (#2624)', () => {
  let events: Array<{ event: string; props: Record<string, unknown> }> = [];
  const realCapture = posthog.capture;

  beforeEach(() => {
    resetModelLoadedSnapshotForTests();
    events = [];
    posthog.capture = ((event: string, props?: Record<string, unknown>) => {
      events.push({ event, props: props ?? {} });
      return undefined;
    }) as typeof posthog.capture;
  });

  afterEach(() => {
    posthog.capture = realCapture;
  });

  describe('captureModelLoaded: the one ifc_model_loaded seam', () => {
    it('emits the event AND retains that load\'s snapshot in one call', () => {
      captureModelLoaded(
        { format: 'ifc', load_path: 'server', file_size_mb: 12.34 },
        { fileSizeMB: 12.34, totalTriangles: 250_000, meshCount: 1_200 },
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'ifc_model_loaded');
      assert.equal(events[0].props.load_path, 'server');
      assert.deepEqual(
        getModelLoadedSnapshot(),
        { fileSizeMB: 12.34, totalTriangles: 250_000, meshCount: 1_200 },
        'the loss report must see the numbers THIS capture reported',
      );
    });

    it('a later capture replaces the previous model\'s numbers wholesale', () => {
      captureModelLoaded({ load_path: 'wasm' }, { fileSizeMB: 900, totalTriangles: 9_000_000, meshCount: 90_000 });
      captureModelLoaded({ load_path: 'cache' }, { fileSizeMB: 1.5, totalTriangles: 300, meshCount: 12 });
      assert.deepEqual(getModelLoadedSnapshot(), { fileSizeMB: 1.5, totalTriangles: 300, meshCount: 12 });
    });
  });

  describe('clearModelLoadedSnapshot: the fail-safe half', () => {
    it('a load that records nothing cannot serve the previous model\'s numbers', () => {
      // The pre-fix failure, in miniature: model A loads via wasm (records),
      // model B starts loading. If B's path never records, the loss report
      // must say NOTHING about the last load - not describe model A.
      recordModelLoadedSnapshot({ fileSizeMB: 900, totalTriangles: 9_000_000, meshCount: 90_000 });
      clearModelLoadedSnapshot();
      assert.equal(
        getModelLoadedSnapshot(),
        null,
        'after a clear, a recording-free path leaves the fields absent, never stale',
      );
    });
  });

  describe('snapshotFromGeometry: absent is not zero', () => {
    it('reads real totals from a GeometryResult-shaped value', () => {
      const snapshot = snapshotFromGeometry(55.5, {
        totalTriangles: 1_000_000,
        meshes: [{}, {}, {}],
      });
      assert.deepEqual(snapshot, { fileSizeMB: 55.5, totalTriangles: 1_000_000, meshCount: 3 });
    });

    it('null geometry records only the size - triangles/meshes stay ABSENT, not 0', () => {
      // A real 0 and an unknown are different facts; a substituted 0 would
      // read as a measured "empty mesh model" in the loss report.
      const snapshot = snapshotFromGeometry(55.5, null);
      assert.equal(snapshot.fileSizeMB, 55.5);
      assert.ok(!('totalTriangles' in snapshot));
      assert.ok(!('meshCount' in snapshot));
    });
  });

  describe('useIfcLoader wiring sweep: every load path stays on the seam', () => {
    // Source-text sweep, same approach as frameWait.test.ts /
    // colorful-popover-opacity.test.ts: the behaviour under test IS the wiring
    // inside a 2600-line React hook that no unit harness can execute, and the
    // unit tests above cannot go red when the loader stops calling the seam.
    const loaderSource = readFileSync(
      fileURLToPath(new URL('../hooks/useIfcLoader.ts', import.meta.url)),
      'utf-8',
    );

    it('has NO bare ifc_model_loaded capture - only captureModelLoaded may emit it', () => {
      assert.ok(
        !loaderSource.includes("posthog.capture('ifc_model_loaded'"),
        'a bare capture skips the snapshot recording, which is how the stale-numbers bug happened',
      );
    });

    it('all six completing load paths call captureModelLoaded', () => {
      // point-cloud, ifcx, glb, cache-hit, server, local wasm. Deleting any
      // path's call drops this count; a seventh path should raise it.
      const calls = loaderSource.match(/\bcaptureModelLoaded\(/g) ?? [];
      assert.ok(
        calls.length >= 6,
        `expected the 6 known load paths to capture through the seam, found ${calls.length}`,
      );
    });

    it('clears the snapshot at the start of the load, before any path can complete', () => {
      const clearAt = loaderSource.indexOf('clearModelLoadedSnapshot()');
      const firstCaptureAt = loaderSource.indexOf('captureModelLoaded(');
      assert.ok(clearAt !== -1, 'the fail-safe clear-at-start must exist');
      assert.ok(
        clearAt < firstCaptureAt,
        'the clear must precede every completing path, or an early-returning path can leave stale numbers',
      );
    });
  });
});
