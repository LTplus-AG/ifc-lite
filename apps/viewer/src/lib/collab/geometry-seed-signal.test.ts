/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The boundary these tests exist for: "this model has no geometry to share"
 * (silent) against "this model's geometry never reached the room" (loud).
 * Collapsing them in either direction is a defect. Reporting the first as a
 * failure makes the alarm cry wolf on every structure-only share; reporting the
 * second as a success is the bug that hid a weeks-long production outage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createCollabDoc, seedFromStep, snapshotToIfcx } from '@ifc-lite/collab';
import type { SeedGeometryReport } from './geometry-sync.js';
import type { GeometrySeedMarker } from './geometry-seed-signal.js';
import {
  classifySeed,
  interruptedSeedMarker,
  markerFromReport,
  missingRoomGeometryMessage,
  readGeometrySeedMarker,
  seedFailureMessage,
  writeGeometrySeedMarker,
} from './geometry-seed-signal.js';

function report(patch: Partial<SeedGeometryReport> = {}): SeedGeometryReport {
  return {
    offered: 0,
    attempted: 0,
    seeded: 0,
    failed: 0,
    skipped: { noPath: 0, noEntity: 0, empty: 0 },
    abandoned: false,
    ...patch,
  };
}

describe('seed outcome: nothing-to-seed vs failed', () => {
  it('reports no failure for a structure-only model (nothing to seed)', () => {
    // A model with no geometry is a legitimate share. No seed runs at all, so
    // the caller holds no report.
    assert.equal(classifySeed(null), 'nothing-to-seed');
    assert.equal(seedFailureMessage(null), null);
    // And the same when a seed ran over an empty mesh list.
    const empty = report({ offered: 0, attempted: 0, seeded: 0 });
    assert.equal(classifySeed(empty), 'nothing-to-seed');
    assert.equal(seedFailureMessage(empty), null);
  });

  it('reports a failure when the model had geometry and the room got none', () => {
    const failed = report({ offered: 120, attempted: 120, seeded: 0, failed: 10, abandoned: true });
    assert.equal(classifySeed(failed), 'failed');
    const message = seedFailureMessage(failed);
    assert.ok(message, 'a share that lost all of its geometry must report a failure');
  });

  it('reports a failure when every mesh was skipped before upload', () => {
    // Bounded-geometry mode: the meshes exist but their CPU data was released,
    // so nothing is uploadable. No exception, no failed request, and an empty
    // room: the case that looks most like success from the inside.
    const released = report({ offered: 900, attempted: 0, seeded: 0, skipped: { noPath: 0, noEntity: 0, empty: 900 } });
    assert.equal(classifySeed(released), 'failed');
    assert.ok(seedFailureMessage(released), 'a model whose meshes were all skipped shared no geometry');
  });

  it('reports a partial share when meshes were dropped before upload', () => {
    // No failed request, no exception: the room is simply missing 40 of the
    // model's elements because their CPU data was released. Classifying this
    // as a clean share is the same silence the whole fix exists to remove.
    const dropped = report({
      offered: 100,
      attempted: 60,
      seeded: 60,
      skipped: { noPath: 0, noEntity: 0, empty: 40 },
    });
    assert.equal(classifySeed(dropped), 'partial');
    assert.ok(seedFailureMessage(dropped));
  });

  it('stays silent when the only skips are meshes with no entity of their own', () => {
    // Deliberate: `noPath`/`noEntity` have no established baseline in a normal
    // share, so they stay in the report and the console rather than becoming a
    // toast on every share.
    const structural = report({
      offered: 100,
      attempted: 98,
      seeded: 98,
      skipped: { noPath: 2, noEntity: 0, empty: 0 },
    });
    assert.equal(classifySeed(structural), 'seeded');
    assert.equal(seedFailureMessage(structural), null);
  });

  it('reports success when every mesh landed', () => {
    const ok = report({ offered: 42, attempted: 42, seeded: 42 });
    assert.equal(classifySeed(ok), 'seeded');
    assert.equal(seedFailureMessage(ok), null);
  });

  it('reports a partial share when some uploads failed', () => {
    // `seeded` and `failed` move together by construction (every attempted job
    // does exactly one of them), which is why the classifier needs only one of
    // the two terms - see the note on `classifySeed`. A fixture varying both
    // cannot distinguish them, so it is not asked to.
    const partial = report({ offered: 10, attempted: 10, seeded: 7, failed: 3 });
    assert.equal(classifySeed(partial), 'partial');
    assert.ok(seedFailureMessage(partial));
  });
});

describe('joiner: warn on a room that should have had geometry', () => {
  const marker = (patch: Partial<GeometrySeedMarker> = {}): GeometrySeedMarker => ({
    expected: 0,
    seeded: 0,
    failed: 0,
    abandoned: false,
    interrupted: false,
    at: '2026-08-18T00:00:00.000Z',
    ...patch,
  });

  it('stays silent when the owner recorded that there was nothing to seed', () => {
    assert.equal(
      missingRoomGeometryMessage({ marker: marker({ expected: 0 }), geometryRecords: 0, hydratedMeshes: 0 }),
      null,
    );
  });

  it('warns when the owner expected geometry and none hydrated', () => {
    const message = missingRoomGeometryMessage({
      marker: marker({ expected: 305, seeded: 0, failed: 10, abandoned: true }),
      geometryRecords: 0,
      hydratedMeshes: 0,
    });
    assert.ok(message, 'entities but zero meshes, and the owner meant to send 305 of them');
  });

  it('stays silent once meshes hydrated', () => {
    assert.equal(
      missingRoomGeometryMessage({ marker: marker({ expected: 305, seeded: 305 }), geometryRecords: 305, hydratedMeshes: 305 }),
      null,
    );
  });

  it('warns when the owner\'s seed threw before it could count its geometry', () => {
    // An interrupted seed records `expected: 0` because it never learned the
    // real number. That must not buy the silence a genuine "nothing to seed"
    // gets: this is the shape a room takes when the share threw outright.
    assert.ok(
      missingRoomGeometryMessage({
        marker: marker({ expected: 0, interrupted: true }),
        geometryRecords: 0,
        hydratedMeshes: 0,
      }),
    );
  });

  it('stays silent on a legacy room with no marker and no geometry records', () => {
    // Indistinguishable from a legitimate structure-only share. Guessing here
    // would fire on every one of them.
    assert.equal(missingRoomGeometryMessage({ marker: null, geometryRecords: 0, hydratedMeshes: 0 }), null);
  });

  it('warns on a legacy room whose geometry records would not download', () => {
    assert.ok(missingRoomGeometryMessage({ marker: null, geometryRecords: 88, hydratedMeshes: 0 }));
  });
});

describe('seed marker in the doc', () => {
  it('round-trips through the room doc', () => {
    const doc = createCollabDoc();
    assert.equal(readGeometrySeedMarker(doc), null, 'a fresh room carries no marker');
    writeGeometrySeedMarker(doc, markerFromReport(report({ offered: 7, attempted: 7, seeded: 7 }), 'now'));
    const read = readGeometrySeedMarker(doc);
    assert.equal(read?.expected, 7);
    assert.equal(read?.seeded, 7);
  });

  it('records expected 0 when no seed ran, so a joiner can trust the silence', () => {
    const doc = createCollabDoc();
    writeGeometrySeedMarker(doc, markerFromReport(null, 'now'));
    assert.equal(readGeometrySeedMarker(doc)?.expected, 0);
  });

  it('carries an interrupted seed through the doc, so a joiner still warns', () => {
    const doc = createCollabDoc();
    writeGeometrySeedMarker(doc, interruptedSeedMarker('now'));
    const read = readGeometrySeedMarker(doc);
    assert.equal(read?.interrupted, true);
    assert.ok(
      missingRoomGeometryMessage({ marker: read, geometryRecords: 0, hydratedMeshes: 0 }),
      'a seed that threw is not a room with nothing to seed',
    );
  });

  it('treats a malformed marker as absent', () => {
    const doc = createCollabDoc();
    doc.getMap('meta').set('geometrySeed', { expected: 'lots' });
    assert.equal(readGeometrySeedMarker(doc), null);
  });

  it('stays out of the IFCX snapshot the joiner rebuilds from', () => {
    const doc = createCollabDoc();
    seedFromStep(doc, { entities: [{ guid: '0aBcDeFgHiJkLmNoPqRsT1', ifcClass: 'IfcWall' }] });
    writeGeometrySeedMarker(doc, markerFromReport(report({ offered: 3, attempted: 3, seeded: 3 }), 'now'));
    const ifcx = snapshotToIfcx(doc);
    assert.equal(ifcx.data?.length, 1, 'the marker is room bookkeeping, not a model node');
  });
});
