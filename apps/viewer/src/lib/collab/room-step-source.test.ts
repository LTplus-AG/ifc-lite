/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as collab from '@ifc-lite/collab';
import { IfcParser } from '@ifc-lite/parser';
import { loadRoomStepSource, parseRoomStepSource } from './room-step-source.js';
import { zipSync } from 'fflate';
import { createEmptyFlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { buildParseResult } from '@/lib/overlay-parse/symbolic-parse.js';
import { placeRoomSymbolic, remapRoomSymbolicOwners, roomSymbolicSource } from './room-symbolic-source.js';
import { joiner, localIdOf, ownerShare } from '@/test/collab-room-harness.js';
import { roomStepExportSource } from './room-step-export.js';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets.js';
import { StepExporter } from '@ifc-lite/export';

function withTaggedQuantityRoot(source: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(source);
  const rows = [
    "#120=IFCBUILDINGELEMENTPROXY('1bbbbbbbbbbbbbbbbbbbbb',$,'Tagged proxy',$,$,$,$,'TAG-42',.NOTDEFINED.);",
    "#121=IFCQUANTITYLENGTH('Length',$,$,12.5,$);",
    "#122=IFCELEMENTQUANTITY('1ccccccccccccccccccccc',$,'Qto_RoomAcceptance',$,$,(#121,#128));",
    "#123=IFCRELDEFINESBYPROPERTIES('1ddddddddddddddddddddd',$,$,$,(#120),#122);",
    "#124=IFCPROPERTYLISTVALUE('Aggregate',$,(IFCLABEL('A'),IFCLABEL('B')),$);",
    "#125=IFCPROPERTYSINGLEVALUE('Collision',$,IFCLABEL('exact'),$);",
    "#126=IFCPROPERTYSET('1eeeeeeeeeeeeeeeeeeeee',$,'Material',$,(#125));",
    "#127=IFCRELDEFINESBYPROPERTIES('1fffffffffffffffffffff',$,$,$,(#79),#126);",
    "#128=IFCQUANTITYCOUNT('Count',$,$,2,$);",
    "#129=IFCPROPERTYSINGLEVALUE('constructor',$,IFCLABEL('safe-a'),$);",
    "#130=IFCPROPERTYSET('1ggggggggggggggggggggg',$,'__proto__',$,(#129));",
    "#131=IFCRELDEFINESBYPROPERTIES('1hhhhhhhhhhhhhhhhhhhhh',$,$,$,(#79),#130);",
    "#132=IFCPROPERTYSINGLEVALUE('__proto__',$,IFCLABEL('safe-b'),$);",
    "#133=IFCPROPERTYSET('1iiiiiiiiiiiiiiiiiiiii',$,'prototype',$,(#132));",
    "#134=IFCRELDEFINESBYPROPERTIES('1jjjjjjjjjjjjjjjjjjjjj',$,$,$,(#79),#133);",
    "#135=IFCQUANTITYCOUNT('__proto__',$,$,3,$);",
    "#136=IFCELEMENTQUANTITY('1kkkkkkkkkkkkkkkkkkkkk',$,'constructor',$,$,(#135));",
    "#137=IFCRELDEFINESBYPROPERTIES('1lllllllllllllllllllll',$,$,$,(#79),#136);",
  ].join('\n');
  const contained = text
    .replace('(#79),#40);', '(#79,#120),#40);')
    .replace('#100));', '#100,#124));');
  return new TextEncoder().encode(contained.replace(/ENDSEC;\s*END-ISO-10303-21;\s*$/, `${rows}\nENDSEC;\nEND-ISO-10303-21;\n`));
}

describe('portable room STEP source (#4604)', () => {
  it('preserves unchanged exact psets, qsets and unprojected root attributes', async () => {
    const control = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const bytes = withTaggedQuantityRoot(control);
    const inputText = new TextDecoder().decode(bytes);
    const inputEntityCount = inputText.match(/^#\d+=/gm)?.length ?? 0;
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer);
    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = collab.modelSlotRef('m0');
    await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'annotation.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      schemaVersion: 'IFC4', fileName: 'annotation.ifc', portableStepSource: bytes,
    }], new Map([['pdf', slot]]));
    const guest = joiner(doc, blobs, 'unchanged-portable');
    await guest.reconstructor.reconstruct();
    const model = guest.store.state().models.values().next().value;
    assert.ok(model?.ifcDataStore);
    const portable = roomStepExportSource(model.ifcDataStore, undefined, model.id);
    assert.ok(portable);
    const output = await new StepExporter(portable.dataStore, portable.mutationView).exportAsync({
      schema: 'IFC4', applyMutations: true, includeGeometry: true,
    });
    const outputText = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
    assert.match(outputText, /IFCPROPERTYSET\([^\n]*'IfcLite_PdfVectorConversion'/);
    assert.match(outputText, /IFCELEMENTQUANTITY\([^\n]*'Qto_RoomAcceptance'/);
    assert.match(outputText, /IFCBUILDINGELEMENTPROXY\([^\n]*'TAG-42'/);
    assert.match(outputText, /IFCPROPERTYLISTVALUE\('Aggregate'[^\n]*IFCLABEL\('A'\),IFCLABEL\('B'\)/);
    assert.match(outputText, /IFCPROPERTYSET\([^\n]*'Material'/,
      'an exact Pset may legally use a display-group-like name');
    assert.match(outputText, /IFCPROPERTYSET\([^\n]*'__proto__'/);
    assert.match(outputText, /IFCPROPERTYSINGLEVALUE\('constructor'[^\n]*'safe-a'/);
    assert.match(outputText, /IFCPROPERTYSET\([^\n]*'prototype'/);
    assert.match(outputText, /IFCPROPERTYSINGLEVALUE\('__proto__'[^\n]*'safe-b'/);
    assert.match(outputText, /IFCELEMENTQUANTITY\([^\n]*'constructor'/);
    assert.match(outputText, /IFCQUANTITYCOUNT\('__proto__'[^\n]*,3,/);
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
    assert.doesNotMatch(outputText, /IFCPROPERTYSET\([^\n]*'IFC Properties/);
    assert.equal(outputText.match(/^#\d+=/gm)?.length ?? 0, inputEntityCount,
      'an unchanged room replay neither drops nor inflates STEP rows');
    guest.reconstructor.teardown();
  });

  it('exports peer Tag edits and member-level quantity deletion', async () => {
    const control = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const bytes = withTaggedQuantityRoot(control);
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer);
    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = collab.modelSlotRef('m0');
    await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'annotation.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      schemaVersion: 'IFC4', fileName: 'annotation.ifc', portableStepSource: bytes,
    }], new Map([['pdf', slot]]));
    const path = `${slot.pathPrefix}/1bbbbbbbbbbbbbbbbbbbbb`;
    collab.setAttribute(doc, path, 'bsi::ifc::prop::Tag', 'TAG-PEER');
    assert.equal(collab.deleteQuantityValue(doc, path, 'Qto_RoomAcceptance', 'Length'), true);

    const guest = joiner(doc, blobs, 'peer-root-edits');
    await guest.reconstructor.reconstruct();
    const model = guest.store.state().models.values().next().value;
    assert.ok(model?.ifcDataStore);
    const portable = roomStepExportSource(model.ifcDataStore, undefined, model.id);
    assert.ok(portable);
    const output = await new StepExporter(portable.dataStore, portable.mutationView).exportAsync({
      schema: 'IFC4', applyMutations: true, includeGeometry: true,
    });
    const outputText = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
    assert.match(outputText, /IFCBUILDINGELEMENTPROXY\([^\n]*'TAG-PEER'/);
    assert.match(outputText, /IFCELEMENTQUANTITY\([^\n]*'Qto_RoomAcceptance'/);
    assert.match(outputText, /IFCQUANTITYCOUNT\('Count'[^\n]*,2\.?0*,/);
    assert.doesNotMatch(outputText, /IFCQUANTITYLENGTH\('Length'/);
    guest.reconstructor.teardown();
  });

  it('exports deletion of an existing portable property set', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer);
    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = collab.modelSlotRef('m0');
    await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'annotation.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      schemaVersion: 'IFC4', fileName: 'annotation.ifc', portableStepSource: bytes,
    }], new Map([['pdf', slot]]));
    const path = `${slot.pathPrefix}/0aaaaaaaaaaaaaaaaaaaaa`;
    const provenance = store.getProperties(79).find(pset => pset.name === 'IfcLite_PdfVectorConversion');
    assert.ok(provenance);
    for (const property of provenance.properties) {
      assert.equal(collab.deletePropertyValue(doc, path, provenance.name, property.name), true);
    }

    const guest = joiner(doc, blobs, 'deleted-portable-pset');
    await guest.reconstructor.reconstruct();
    const model = guest.store.state().models.values().next().value;
    assert.ok(model?.ifcDataStore);
    const portable = roomStepExportSource(model.ifcDataStore, undefined, model.id);
    assert.ok(portable);
    const output = await new StepExporter(portable.dataStore, portable.mutationView).exportAsync({
      schema: 'IFC4', applyMutations: true, includeGeometry: true,
    });
    const outputText = typeof output.content === 'string' ? output.content : new TextDecoder().decode(output.content);
    assert.doesNotMatch(outputText, /IFCPROPERTYSET\([^\n]*'IfcLite_PdfVectorConversion'/);
    guest.reconstructor.teardown();
  });

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

  it('retains exact IFCZIP model and texture paths for a fresh room binding', async () => {
    modelAppearanceAssets.clear();
    const step = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lWkmWQAAAABJRU5ErkJggg==', 'base64'));
    const archive = zipSync({ 'project/model.ifc': step, 'project/textures/scan.png': png });
    const blobs = new collab.MemoryBlobStore();
    const { hash } = await blobs.put(archive);
    const source = await loadRoomStepSource(blobs, hash, 'ifczip');
    assert.equal(source.resources?.modelPath, 'project/model.ifc');
    assert.deepEqual([...source.resources?.resources.keys() ?? []], ['project/textures/scan.png']);
    const texture = source.resources?.resources.get('project/textures/scan.png');
    assert.ok(texture);
    assert.deepEqual(texture, png);

    const doc = collab.createCollabDoc();
    const store = await new IfcParser().parseColumnar(step.slice().buffer);
    const slot = collab.modelSlotRef('m0');
    await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'model.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      portableStepSource: archive, portableStepSourceFormat: 'ifczip',
    }], new Map([['pdf', slot]]));
    const guest = joiner(doc, blobs, 'ifczip-room');
    await guest.reconstructor.reconstruct();
    const roomModelId = guest.store.state().models.keys().next().value;
    assert.ok(roomModelId);
    const originals = modelAppearanceAssets.exportOriginals(roomModelId);
    assert.equal(originals.modelPath, 'project/model.ifc');
    assert.deepEqual(originals.resources.get('project/textures/scan.png'), png);
    const authoredPng = png.slice();
    authoredPng[authoredPng.length - 1] ^= 1;
    const draftOwner = { kind: 'draft' as const, id: 'guest-texture' };
    const authored = await appearanceAssets.add(authoredPng, { owner: draftOwner });
    modelAppearanceAssets.registerAuthored(roomModelId, 'guest-command', [authored.id]);
    const combined = modelAppearanceAssets.exportResources(roomModelId);
    assert.equal(combined.resources.size, 2, 'guest-authored and shared originals coexist in export');
    assert.deepEqual(combined.resources.get('project/textures/scan.png'), png);
    appearanceAssets.releaseOwner(draftOwner);
    modelAppearanceAssets.clear();
  });

  it('drops a deleted portable annotation without hiding surviving symbols', () => {
    const flat = createEmptyFlatSymbolic();
    flat.typeNames = ['IfcAnnotation'];
    flat.fillPoints = Float32Array.from([0, 0, 1, 0, 0, 1, 2, 0, 3, 0, 2, 1]);
    flat.fillPointStart = Uint32Array.from([0, 6, 12]);
    flat.fillHoleStart = Uint32Array.from([0, 0, 0]);
    flat.fillColor = Float32Array.from([1, 0, 0, 1, 0, 1, 0, 1]);
    flat.fillHatch = Float32Array.from([0, 0, Number.NaN, 0, 0, 0, Number.NaN, 0]);
    flat.fillOwner = Uint32Array.from([79, 80]);
    flat.fillGeometryItem = Uint32Array.from([0, 0]);
    flat.fillWorldY = Float32Array.from([Number.NaN, Number.NaN]);
    flat.fillFlags = Uint8Array.from([0, 0]);
    flat.fillType = Uint16Array.from([0, 0]);
    const remapped = remapRoomSymbolicOwners(flat, new Map([[80, 18]]));
    assert.deepEqual(remapped.fillOwner, new Uint32Array([0, 18]));
    const result = buildParseResult(remapped, {});
    assert.deepEqual(result.looseFills.map(fill => fill.ownerId), [18]);
  });

  it('moves and rotates symbolic coordinates by the room placement delta', () => {
    const flat = createEmptyFlatSymbolic();
    flat.fillPoints = Float32Array.from([0, 0, 2, 0, 0, 1]);
    flat.fillPointStart = Uint32Array.from([0, 6]);
    flat.fillOwner = Uint32Array.from([79]);
    flat.fillWorldY = Float32Array.from([3]);
    const placed = placeRoomSymbolic(flat, {
      dataStore: {} as never,
      source: {} as never,
      seededIds: new Set([79]),
      ownerIds: new Map([[79, 17]]),
      baselines: new Map([[79, { location: [0, 0, 0], refDirection: [1, 0, 0] }]]),
      placements: new Map([[79, { location: [4, 5, 6], refDirection: [0, 1, 0] }]]),
      structuredPsets: new Map(),
      structuredQuantities: new Map(),
      structuredAttributes: new Map(),
    });
    assert.deepEqual([...placed.fillOwner], [17]);
    assert.deepEqual([...placed.fillPoints].map(value => Math.round(value * 10) / 10), [4.5, -3.5, 4.5, -5.5, 5.5, -3.5]);
    assert.deepEqual([...placed.fillWorldY], [9]);
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

  it('rejects wrong bytes returned under a syntactically valid source key', async () => {
    const good = new TextEncoder().encode('portable IFC source');
    const wrong = new TextEncoder().encode('different relay bytes');
    const backing = new collab.MemoryBlobStore();
    const { hash } = await backing.put(good);
    const swapped: collab.BlobStore = {
      hashBytes: bytes => backing.hashBytes(bytes),
      put: (value, contentType) => backing.put(value, contentType),
      get: async () => wrong,
      has: hashValue => backing.has(hashValue),
      delete: hashValue => backing.delete(hashValue),
      list: () => backing.list(),
    };
    await assert.rejects(
      parseRoomStepSource(swapped, hash, collab.modelSlotRef('m0'), new Map()),
      /failed its content identity check/,
    );
  });

  it('verifies room sources with the blob store custom hasher', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const custom = (value: Uint8Array) => collab.fnv128(value).split('').reverse().join('');
    const blobs = new collab.MemoryBlobStore(custom);
    const { hash } = await blobs.put(bytes);
    const parsed = await parseRoomStepSource(blobs, hash, collab.modelSlotRef('m0'), new Map());
    assert.equal(parsed.source.byteLength, bytes.byteLength);
  });

  it('retries transient blob read failures and reports the final failure', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    let reads = 0;
    const recovering: collab.BlobStore = {
      hashBytes: collab.fnv128,
      put: async () => { throw new Error('unused'); },
      get: async () => {
        reads++;
        if (reads < 3) throw new Error(`relay read ${reads}`);
        return bytes;
      },
      has: async () => true,
      delete: async () => false,
      list: async () => [],
    };
    const parsed = await parseRoomStepSource(
      recovering, collab.fnv128(bytes), collab.modelSlotRef('m0'), new Map(),
    );
    assert.ok(parsed.source.byteLength > 0);
    assert.equal(reads, 3);

    reads = 0;
    const failing: collab.BlobStore = {
      ...recovering,
      get: async () => { reads++; throw new Error(`relay read ${reads}`); },
    };
    await assert.rejects(
      parseRoomStepSource(failing, 'b'.repeat(32), collab.modelSlotRef('m0'), new Map()),
      /after 3 attempts.*relay read 3/,
    );
    assert.equal(reads, 3);
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
    assert.ok(initialSource, guest.notices.join('; '));
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

  it('does not publish a model after the room closes during sidecar fetch', async () => {
    const bytes = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer);
    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = collab.modelSlotRef('m0');
    await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'annotation.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      portableStepSource: bytes,
    }], new Map([['pdf', slot]]));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const delayed: collab.BlobStore = {
      hashBytes: value => blobs.hashBytes(value),
      put: (value, contentType) => blobs.put(value, contentType),
      get: async hash => { reads++; await gate; return blobs.get(hash); },
      has: hash => blobs.has(hash), delete: hash => blobs.delete(hash), list: () => blobs.list(),
    };
    const guest = joiner(doc, delayed, 'closed-during-fetch');
    const pending = guest.reconstructor.reconstruct();
    for (let turn = 0; reads === 0 && turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(reads > 0);
    guest.store.state().collabRoomId = null;
    release();
    await pending;
    assert.equal(guest.store.state().models.size, 0);
  });

  it('aborts a pending room texture decode when the room is torn down', async () => {
    modelAppearanceAssets.clear();
    const step = new Uint8Array(await readFile(new URL(
      '../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.ifc',
      import.meta.url,
    )));
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lWkmWQAAAABJRU5ErkJggg==', 'base64'));
    const archive = zipSync({ 'model.ifc': step, 'texture.png': png });
    const store = await new IfcParser().parseColumnar(step.slice().buffer);
    const doc = collab.createCollabDoc();
    const blobs = new collab.MemoryBlobStore();
    const slot = collab.modelSlotRef('m0');
    await ownerShare(doc, blobs, [{
      modelId: 'pdf', name: 'model.ifc', store, isIfcx: false, meshes: [], idOffset: 0,
      portableStepSource: archive, portableStepSourceFormat: 'ifczip',
    }], new Map([['pdf', slot]]));

    const originalDecode = appearanceAssets.decode.bind(appearanceAssets);
    let decodeSignal: AbortSignal | undefined;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    appearanceAssets.decode = async (_id, _owner, signal) => {
      decodeSignal = signal;
      signalStarted();
      return await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const guest = joiner(doc, blobs, 'decode-cancel');
    try {
      const pending = guest.reconstructor.reconstruct();
      await started;
      guest.store.state().collabRoomId = null;
      guest.reconstructor.teardown();
      await pending;
      assert.equal(decodeSignal?.aborted, true);
      assert.equal(guest.store.state().models.size, 0);
    } finally {
      appearanceAssets.decode = originalDecode;
      modelAppearanceAssets.clear();
    }
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
