/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as collab from '@ifc-lite/collab';
import { IfcParser } from '@ifc-lite/parser';
import { parseRoomStepSource } from './room-step-source.js';
import { createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { remapRoomSymbolicOwners, roomSymbolicSource } from './room-symbolic-source.js';
import { joiner, localIdOf, ownerShare } from '@/test/collab-room-harness.js';
import { roomStepExportSource } from './room-step-export.js';

describe('portable room STEP source (#4604)', () => {
  it('retains the PDF annotation source and maps its owner into the room id space', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const blobs = new collab.MemoryBlobStore();
    const { hash } = await blobs.put(bytes);
    const slot = collab.modelSlotRef('m0');
    const roomPath = `${slot.pathPrefix}/0aaaaaaaaaaaaaaaaaaaaa`;
    const source = await parseRoomStepSource(blobs, hash, slot, new Map([[roomPath, 17]]));
    assert.ok(source.source.byteLength > 0);
    assert.equal(source.ownerIds.get(79), 17, 'the source IfcAnnotation maps through its GlobalId path');
    assert.equal(source.dataStore.entities.getTypeName(79), 'IfcAnnotation');

    const flat = createEmptyFlatSymbolic();
    flat.fillOwner = new Uint32Array([79, 79]);
    assert.deepEqual(remapRoomSymbolicOwners(flat, source.ownerIds).fillOwner, new Uint32Array([17, 17]));
  });

  it('rejects malformed and missing source references without inventing an empty source', async () => {
    const blobs = new collab.MemoryBlobStore();
    await assert.rejects(parseRoomStepSource(blobs, '../room', collab.modelSlotRef('m0'), new Map()), /invalid/);
    await assert.rejects(parseRoomStepSource(blobs, 'a'.repeat(32), collab.modelSlotRef('m0'), new Map()), /unavailable/);
  });

  it('rejects fetched source bytes over the 96 MiB limit before copying or parsing', async () => {
    const oversized = {
      byteLength: 96 * 1024 * 1024 + 1,
    } as unknown as Uint8Array;
    const blobs: collab.BlobStore = {
      put: async () => { throw new Error('unused'); },
      get: async () => oversized,
      has: async () => true,
      delete: async () => false,
      list: async () => [],
    };
    await assert.rejects(
      parseRoomStepSource(blobs, 'a'.repeat(32), collab.modelSlotRef('m0'), new Map()),
      /96 MiB/,
    );
  });

  it('keeps snapshot-only roots selectable when a room adds them after the portable source', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer);
    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = collab.modelSlotRef('m0');
    const shared = await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'annotation.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      schemaVersion: 'IFC4', fileName: 'annotation.ifc', portableStepSource: bytes,
    }], new Map([['pdf', slot]]));
    assert.deepEqual(shared.outcome, { phase: 'ready', failure: null });

    const guest = joiner(doc, blobs, 'portable-plus-live');
    await guest.reconstructor.reconstruct();
    const initialModel = guest.store.state().models.values().next().value;
    assert.ok(initialModel);
    const initialSource = roomSymbolicSource(initialModel.ifcDataStore!);
    assert.ok(initialSource);
    assert.equal(initialSource.ownerIds.get(79), localIdOf(initialModel, `${slot.pathPrefix}/0aaaaaaaaaaaaaaaaaaaaa`));

    const createdPath = `${slot.pathPrefix}/1bbbbbbbbbbbbbbbbbbbbb`;
    collab.createEntity(doc, createdPath, { ifcClass: 'IfcWall', attributes: { 'bsi::ifc::prop::Name': 'Room-created wall' } });
    await guest.reconstructor.reconstruct();
    const model = guest.store.state().models.values().next().value;
    assert.ok(model);
    const rebound = roomSymbolicSource(model.ifcDataStore!);
    assert.ok(rebound, 'fresh join retains the complete portable STEP sidecar');
    assert.notStrictEqual(rebound, initialSource, 'cached STEP rows are rebound to every current reconstruction');
    assert.equal(rebound.ownerIds.get(79), localIdOf(model, `${slot.pathPrefix}/0aaaaaaaaaaaaaaaaaaaaa`));
    const createdId = localIdOf(model, createdPath);
    assert.equal(model.ifcDataStore?.entities.getName(createdId), 'Room-created wall');
    assert.deepEqual(guest.store.state().resolveGlobalIdFromModels(model.idOffset + createdId), {
      modelId: model.id, expressId: createdId,
    });
    assert.equal(
      roomStepExportSource(model.ifcDataStore!, undefined, model.id),
      null,
      'export falls back to IFCX instead of dropping the room-created root',
    );
    guest.reconstructor.teardown();
  });

  it('falls back to IFCX when the room deletes a root that remains in the frozen STEP source', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer);
    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = collab.modelSlotRef('m0');
    const shared = await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'annotation.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      schemaVersion: 'IFC4', fileName: 'annotation.ifc', portableStepSource: bytes,
    }], new Map([['pdf', slot]]));
    assert.deepEqual(shared.outcome, { phase: 'ready', failure: null });
    assert.equal(collab.deleteEntity(doc, `${slot.pathPrefix}/0aaaaaaaaaaaaaaaaaaaaa`), true);

    const guest = joiner(doc, blobs, 'portable-minus-root');
    await guest.reconstructor.reconstruct();
    const model = guest.store.state().models.values().next().value;
    assert.ok(model?.ifcDataStore);
    assert.equal(roomStepExportSource(model.ifcDataStore, undefined, model.id), null,
      'portable export must not resurrect the deleted annotation');
    guest.reconstructor.teardown();
  });
});
