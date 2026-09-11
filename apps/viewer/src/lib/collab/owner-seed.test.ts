/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4446 — the owner's seed reports where it stands, and a fresh guest who
 * opens the room the moment it reports `ready` gets the complete model.
 *
 * Drives the REAL `runOwnerSeed` against a REAL `@ifc-lite/collab` session
 * (memory provider) and blob store, then reconstructs the room the way the
 * recipient branch of `startCollab` does: `snapshotToIfcx` -> the viewer's own
 * IFCX ingest -> `hydrateGeometryFromRoom` keyed by the recipient's id space.
 * The guest-side counts are asserted against the owner's own seed report, so
 * "ready" and "complete" are pinned to the same numbers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as collab from '@ifc-lite/collab';
import type { MeshData } from '@ifc-lite/geometry';
import { runOwnerSeed, type OwnerSeedDeps, type OwnerSeedResult } from './owner-seed.js';
import { hydrateGeometryFromRoom } from './geometry-sync.js';
import { readGeometrySeedMarker } from './geometry-seed-signal.js';
import { buildStepSeedSource } from './step-seed.js';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest.js';
import {
  SEED_GUIDS,
  SEED_TEXTURE_PIXELS,
  seedFixtureMeshes,
  seedFixtureStore,
} from '@/test/collab-seed-fixture.js';

const user = { id: 'owner', name: 'Owner', color: '#123456' };

interface Harness {
  session: collab.CollabSession;
  blobStore: collab.MemoryBlobStore;
  phases: string[];
  progress: Array<[number, number]>;
  run: (overrides?: Partial<OwnerSeedDeps>) => Promise<OwnerSeedResult | null>;
}

async function harness(meshes: readonly MeshData[] = seedFixtureMeshes()): Promise<Harness> {
  const session = await collab.createCollabSession({ roomId: `seed-${Math.random()}`, user, provider: 'memory' });
  const blobStore = new collab.MemoryBlobStore();
  const store = seedFixtureStore();
  const phases: string[] = [];
  const progress: Array<[number, number]> = [];
  const deps: OwnerSeedDeps = {
    session,
    seed: () => ({ store, isIfcx: false, stepSource: buildStepSeedSource(store, 'fixture.ifc') }),
    collab,
    geomApi: collab,
    makeBlobStore: async () => blobStore,
    stepMeshes: () => meshes,
    stampBaseline: (path) => {
      if (path) {
        const current = collab.getEntityPlacement(session.doc, path);
        collab.setPlacementBaseline(session.doc, path, current ?? { location: [0, 0, 0] });
      }
      return path;
    },
    isCurrent: () => true,
    onPhase: (phase) => phases.push(phase),
    onProgress: (uploaded, total) => progress.push([uploaded, total]),
  };
  return {
    session,
    blobStore,
    phases,
    progress,
    run: (overrides = {}) => runOwnerSeed({ ...deps, ...overrides }),
  };
}

describe('runOwnerSeed (#4446)', () => {
  it('walks structure -> geometry, reports progress, and settles ready only once the room holds it all', async () => {
    const h = await harness();
    try {
      const result = await h.run();
      assert.deepEqual(result, { phase: 'ready', failure: null });
      assert.deepEqual(h.phases, ['structure', 'geometry']);
      // `seedGeometryToRoom` reports every 50 blobs and once at the end.
      assert.deepEqual(h.progress.at(-1), [2, 2], 'the final progress tick is the full count');

      // "Ready" is pinned to the doc actually holding the model.
      const doc = h.session.doc;
      assert.equal(doc.getMap('entities').size, 2, 'both products seeded');
      assert.equal(doc.getMap('geometry').size, 2, 'both meshes referenced');
      for (const guid of Object.values(SEED_GUIDS)) {
        const ref = collab.getGeometryRef(doc, collab.guidToPath(guid));
        assert.equal(ref?.geomIds.length, 1, `${guid} carries its geometry ref`);
      }
      const marker = readGeometrySeedMarker(doc);
      assert.equal(marker?.expected, 2);
      assert.equal(marker?.seeded, 2);
      assert.equal(marker?.interrupted, false);
    } finally {
      h.session.dispose();
    }
  });

  it('a fresh guest reconstructs the complete model and textures from the ready room', async () => {
    const h = await harness();
    try {
      const result = await h.run();
      assert.equal(result?.phase, 'ready');

      // The recipient branch of startCollab, step for step: the synced doc is
      // snapshotted to IFCX, parsed by the viewer's own ingest (which yields
      // the recipient's id space), and geometry is hydrated from the blobs
      // keyed by that id space.
      const recipient = await collab.createCollabSession({ roomId: 'guest', user, provider: 'memory' });
      try {
        collab.seedFromIfcx(recipient.doc, JSON.stringify(collab.snapshotToIfcx(h.session.doc)));
        const ifcx = new TextEncoder().encode(JSON.stringify(collab.snapshotToIfcx(recipient.doc)));
        const parsed = await parseIfcxViewerModel(ifcx.buffer as ArrayBuffer, undefined, { allowEmptyGeometry: true });
        assert.ok(parsed.pathToId, 'the ingest exposes the recipient id map');
        for (const guid of Object.values(SEED_GUIDS)) {
          assert.ok(parsed.pathToId.has(collab.guidToPath(guid)), `${guid} is an entity on the guest`);
        }

        const meshes = await hydrateGeometryFromRoom(collab, recipient, h.blobStore, parsed.pathToId);
        const marker = readGeometrySeedMarker(h.session.doc);
        assert.equal(meshes.length, marker?.seeded, 'the guest gets exactly what the owner reported as seeded');
        assert.equal(meshes.length, 2);
        const guestIds = new Set(Object.values(SEED_GUIDS).map((g) => parsed.pathToId!.get(collab.guidToPath(g))));
        for (const mesh of meshes) {
          assert.ok(guestIds.has(mesh.expressId), 'meshes are re-keyed into the guest id space');
          assert.deepEqual(mesh.texture?.rgba, SEED_TEXTURE_PIXELS, 'the texture pixels arrive byte-exact');
          assert.equal(mesh.texture?.repeatT, true, 'the sampler survives');
          assert.deepEqual(mesh.uvs, seedFixtureMeshes()[0].uvs);
        }
      } finally {
        recipient.dispose();
      }
    } finally {
      h.session.dispose();
    }
  });

  it('re-running on a room that already holds the model changes nothing and is ready at once', async () => {
    const h = await harness();
    try {
      assert.equal((await h.run())?.phase, 'ready');
      h.phases.length = 0;
      const again = await h.run();
      assert.deepEqual(again, { phase: 'ready', failure: null });
      assert.deepEqual(h.phases, [], 'neither structure nor geometry is re-seeded');
      assert.equal(h.session.doc.getMap('geometry').size, 2);
    } finally {
      h.session.dispose();
    }
  });

  it('an abandoned join (user left during sync) seeds nothing and reports nothing', async () => {
    const h = await harness();
    try {
      const result = await h.run({ isCurrent: () => false });
      assert.equal(result, null);
      assert.deepEqual(h.phases, []);
      assert.equal(h.session.doc.getMap('entities').size, 0);
      assert.equal(readGeometrySeedMarker(h.session.doc), null, 'no marker for a seed that never ran');
    } finally {
      h.session.dispose();
    }
  });

  it('settles partial when a mesh the model has cannot be sent, with the owner-facing reason', async () => {
    // One mesh memory-released (no triangles): the room gets the other one.
    const released: MeshData = { ...seedFixtureMeshes()[1], positions: new Float32Array(0), indices: new Uint32Array(0) };
    const h = await harness([seedFixtureMeshes()[0], released]);
    try {
      const result = await h.run();
      assert.equal(result?.phase, 'partial');
      assert.match(result?.failure ?? '', /1 of 2 elements could not be sent/);
      assert.equal(h.session.doc.getMap('geometry').size, 1);
    } finally {
      h.session.dispose();
    }
  });

  it('settles failed when the room got structure but none of the geometry', async () => {
    // A textured mesh whose image is unavailable fails explicitly (#4232).
    const orphaned: MeshData = { ...seedFixtureMeshes()[0] };
    delete orphaned.texture;
    orphaned.textureRef = { textureId: 1, url: 'image.png', repeatS: true, repeatT: false };
    const h = await harness([orphaned]);
    try {
      const result = await h.run();
      assert.equal(result?.phase, 'failed');
      assert.match(result?.failure ?? '', /no 3D geometry|source image is unavailable/, 'names the loss to the owner');
      assert.equal(h.session.doc.getMap('entities').size, 2, 'structure landed');
      assert.equal(h.session.doc.getMap('geometry').size, 0, 'geometry did not');
      const marker = readGeometrySeedMarker(h.session.doc);
      assert.equal(marker?.expected, 1);
      assert.equal(marker?.seeded, 0);
    } finally {
      h.session.dispose();
    }
  });

  it('a seed that throws settles failed and stamps the room as interrupted', async () => {
    const h = await harness();
    try {
      const result = await h.run({
        makeBlobStore: async () => {
          throw new Error('blob store unreachable');
        },
      });
      assert.equal(result?.phase, 'failed');
      assert.match(result?.failure ?? '', /did not complete/);
      const marker = readGeometrySeedMarker(h.session.doc);
      assert.equal(marker?.interrupted, true, 'joiners are told the seed was interrupted, not "nothing to seed"');
    } finally {
      h.session.dispose();
    }
  });
});
