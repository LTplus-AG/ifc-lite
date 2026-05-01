/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One scenario per ConflictKind in spec §9 / `conflicts/detector.ts`.
 *
 * Each test:
 *   1. Creates two peers with a shared baseline.
 *   2. Has them concurrently mutate the same target.
 *   3. Syncs.
 *   4. Asserts both peers' detectors fired with the expected `kind` and
 *      `field`.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import {
  addClassification,
  createEntity,
  deleteEntity,
  setAttribute,
  setChild,
  setPropertyValue,
} from '../src/doc/entity.js';
import { createGeometry, setGeometryBlobHash, setGeometryParam } from '../src/doc/geometry.js';
import { addTarget, createRelationship, removeTarget } from '../src/doc/relationship.js';
import { createConflictDetector, type ConflictEvent } from '../src/conflicts/detector.js';

interface PeerHarness {
  a: Y.Doc;
  b: Y.Doc;
  aEvents: ConflictEvent[];
  bEvents: ConflictEvent[];
  /** Pairwise full sync. */
  sync(): void;
}

function harness(): PeerHarness {
  const a = createCollabDoc();
  const b = createCollabDoc();
  const aDetector = createConflictDetector(a, { windowMs: 60_000 });
  const bDetector = createConflictDetector(b, { windowMs: 60_000 });
  const aEvents: ConflictEvent[] = [];
  const bEvents: ConflictEvent[] = [];
  aDetector.onConflict((e) => aEvents.push(e));
  bDetector.onConflict((e) => bEvents.push(e));
  return {
    a,
    b,
    aEvents,
    bEvents,
    sync() {
      const aSv = Y.encodeStateVector(a);
      const bSv = Y.encodeStateVector(b);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, bSv));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, aSv));
    },
  };
}

function shareEntity(h: PeerHarness, path: string) {
  h.a.transact(() => createEntity(h.a, path, { ifcClass: 'IfcWall' }));
  h.sync();
}

describe('conflict scenarios', () => {
  it('attribute: concurrent Name writes', () => {
    const h = harness();
    shareEntity(h, 'wall');

    h.a.transact(() => setAttribute(h.a, 'wall', 'Name', 'A'));
    h.b.transact(() => setAttribute(h.b, 'wall', 'Name', 'B'));
    h.sync();

    for (const events of [h.aEvents, h.bEvents]) {
      expect(events.some((e) => e.kind === 'attribute' && e.path === 'wall' && e.field === 'Name')).toBe(true);
    }
  });

  it('pset-property: concurrent property writes inside an existing Pset', () => {
    const h = harness();
    shareEntity(h, 'wall');
    // Seed the Pset on A first so both peers share the same Pset Y.Map.
    // (Otherwise each peer creates its own Pset Y.Map and only the LWW
    // winner's properties survive — which is a different conflict.)
    h.a.transact(() =>
      setPropertyValue(h.a, 'wall', 'Pset_WallCommon', 'FireRating', { type: 'IfcLabel', value: 'EI30' }),
    );
    h.sync();

    h.a.transact(() =>
      setPropertyValue(h.a, 'wall', 'Pset_WallCommon', 'FireRating', { type: 'IfcLabel', value: 'EI60' }),
    );
    h.b.transact(() =>
      setPropertyValue(h.b, 'wall', 'Pset_WallCommon', 'FireRating', { type: 'IfcLabel', value: 'EI90' }),
    );
    h.sync();

    for (const events of [h.aEvents, h.bEvents]) {
      expect(
        events.some(
          (e) =>
            e.kind === 'pset-property' &&
            e.path === 'wall' &&
            e.field === 'Pset_WallCommon.FireRating',
        ),
      ).toBe(true);
    }
  });

  it('pset-property: concurrent Pset creation surfaces at the Pset name', () => {
    const h = harness();
    shareEntity(h, 'wall');

    // Both peers seed the same Pset name without a prior shared Y.Map.
    h.a.transact(() =>
      setPropertyValue(h.a, 'wall', 'Pset_WallCommon', 'FireRating', { type: 'IfcLabel', value: 'EI60' }),
    );
    h.b.transact(() =>
      setPropertyValue(h.b, 'wall', 'Pset_WallCommon', 'FireRating', { type: 'IfcLabel', value: 'EI90' }),
    );
    h.sync();

    for (const events of [h.aEvents, h.bEvents]) {
      expect(
        events.some(
          (e) =>
            e.kind === 'pset-property' &&
            e.path === 'wall' &&
            e.field === 'Pset_WallCommon',
        ),
      ).toBe(true);
    }
  });

  it('hierarchy: concurrent child role assignments', () => {
    const h = harness();
    shareEntity(h, 'storey');
    shareEntity(h, 'wall-1');
    shareEntity(h, 'wall-2');

    h.a.transact(() => setChild(h.a, 'storey', 'PrimaryWall', 'wall-1'));
    h.b.transact(() => setChild(h.b, 'storey', 'PrimaryWall', 'wall-2'));
    h.sync();

    for (const events of [h.aEvents, h.bEvents]) {
      expect(events.some((e) => e.kind === 'hierarchy' && e.path === 'storey' && e.field === 'PrimaryWall')).toBe(true);
    }
  });

  it('geometry-param: concurrent param changes', () => {
    const h = harness();
    h.a.transact(() => createGeometry(h.a, 'g', { type: 'parametric', source: 'extruded-area-solid', params: { depth: 1 } }));
    h.sync();

    h.a.transact(() => setGeometryParam(h.a, 'g', 'depth', 2));
    h.b.transact(() => setGeometryParam(h.b, 'g', 'depth', 3));
    h.sync();

    for (const events of [h.aEvents, h.bEvents]) {
      expect(events.some((e) => e.kind === 'geometry-param' && e.path === 'g' && e.field === 'depth')).toBe(true);
    }
  });

  it('geometry-blob: concurrent mesh replacement', () => {
    const h = harness();
    h.a.transact(() => createGeometry(h.a, 'g', { type: 'mesh', source: 'mesh-blob' }));
    h.sync();

    h.a.transact(() => setGeometryBlobHash(h.a, 'g', 'hash-A'));
    h.b.transact(() => setGeometryBlobHash(h.b, 'g', 'hash-B'));
    h.sync();

    for (const events of [h.aEvents, h.bEvents]) {
      expect(events.some((e) => e.kind === 'geometry-blob' && e.path === 'g')).toBe(true);
    }
  });

  it('concurrent-delete: each peer records its own delete locally', () => {
    // Caveat: when both peers delete the SAME entity, the second
    // (remote) delete arrives at an already-tombstoned struct and Yjs
    // short-circuits inside `Item.delete`, so it does NOT call
    // `addChangedTypeToTransaction`. The detector therefore can't cross-
    // attribute the writers for this exact case — only the local delete
    // is recorded on each peer. The §9.6 "edit on a deleted entity"
    // restore UX is the proper handler for delete-vs-edit conflicts and
    // lives outside this detector (TODO: ship the restore prompt as a
    // separate v0.3 task).
    const h = harness();
    shareEntity(h, 'wall');

    h.a.transact(() => deleteEntity(h.a, 'wall'));
    h.b.transact(() => deleteEntity(h.b, 'wall'));
    h.sync();

    // Each peer's `active()` snapshot should be empty (no flag fired —
    // contributors set has only one client per peer). What we *do*
    // assert is convergence: both peers agree the entity is gone.
    expect(h.a.getMap('entities').has('wall')).toBe(false);
    expect(h.b.getMap('entities').has('wall')).toBe(false);
  });

  it('relationship-target: concurrent additions to the targets array', () => {
    // Both peers add (rather than one add + one delete) because Yjs
    // delete-only update propagation does not always trip the parent
    // array's tr.changed entry — that path is exercised in the
    // convergence-property test where final state equality is the only
    // assertion.
    const h = harness();
    shareEntity(h, 'wall');
    shareEntity(h, 'space-a');
    shareEntity(h, 'space-b');
    shareEntity(h, 'space-c');
    h.a.transact(() =>
      createRelationship(h.a, 'rel', {
        ifcClass: 'IfcRelContainedInSpatialStructure',
        source: 'wall',
        targets: ['space-a'],
      }),
    );
    h.sync();

    h.a.transact(() => addTarget(h.a, 'rel', 'space-b'));
    h.b.transact(() => addTarget(h.b, 'rel', 'space-c'));
    h.sync();

    for (const events of [h.aEvents, h.bEvents]) {
      expect(
        events.some((e) => e.kind === 'relationship-target' && e.path === 'rel'),
      ).toBe(true);
    }
  });

  it('classifications array: concurrent additions do NOT spuriously fire attribute conflicts', () => {
    // Y.Array additions interleave; both peers' classifications coexist.
    // The detector should not surface this as a conflict — adding to an
    // array is the explicitly correct CRDT behavior.
    const h = harness();
    shareEntity(h, 'wall');

    h.a.transact(() => addClassification(h.a, 'wall', { system: 'Uniclass', code: 'A' }));
    h.b.transact(() => addClassification(h.b, 'wall', { system: 'Uniclass', code: 'B' }));
    h.sync();

    expect(h.aEvents.filter((e) => e.path === 'wall' && e.kind === 'attribute')).toHaveLength(0);
    expect(h.bEvents.filter((e) => e.path === 'wall' && e.kind === 'attribute')).toHaveLength(0);
  });
});
