/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4444 on the real model the issue names: `AC20-FZK-Haus.ifc` loaded twice,
 * a different appearance on the same member in each copy, shared into ONE
 * room, reconstructed by a fresh guest, and again after a rejoin.
 *
 * Both copies are parsed by the real STEP parser and tessellated by the real
 * WASM geometry pipeline, so every IFC identity collides on purpose — same
 * GlobalIds, same express ids, same file name, same bytes. What tells them
 * apart is only the room slot and the federation range, and that is what the
 * assertions check: entity counts double, geometry refs are per slot, each
 * guest model hydrates its own copy's meshes and its own texture, and a pick
 * (global id → model) resolves to the copy the mesh belongs to.
 *
 * Skips (never fails) when the fixture or the wasm runtime is absent; CI
 * fetches both (`pnpm fixtures`, `pnpm build:wasm`). The fixture must stay in
 * the committed manifest, so its absence from disk is a skip but its absence
 * from the manifest is a failure — otherwise this would go vacuous unseen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as collab from '@ifc-lite/collab';
import { Ifc5Exporter } from '@ifc-lite/export';
import { IFCX_APPEARANCE, IFCX_IMAGE } from '@ifc-lite/ifcx';
import type { ModelSlotRef } from '@ifc-lite/collab';
import { ColumnarParser, StepTokenizer, type IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor, type MeshData } from '@ifc-lite/geometry';
import { applyFederationOffsetToMesh } from '../../hooks/ingest/federationOffset.js';
import { readGeometrySeedMarker } from './geometry-seed-signal.js';
import type { CollabSeedModel } from './owner-seed.js';
import { roomSlotRef } from './model-slot-ref.js';
import { roomExportPathPrefix } from './room-export-paths.js';
import { joiner, localIdOf, ownerShare, texturePixel, type RoomTestState } from '../../test/collab-room-harness.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const WASM = 'packages/wasm/pkg/ifc-lite_bg.wasm';

/** The real STEP parse, the way the viewer's loader does it off the main thread. */
async function parseStore(bytes: Uint8Array): Promise<IfcDataStore> {
  const refs = Array.from(new StepTokenizer(bytes).scanEntitiesFast(), (ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(bytes.buffer as ArrayBuffer, refs, {});
}

/** One copy's meshes: the shared tessellation, re-homed into `idOffset`, with `rgb` painted on `paintedId`. */
function copyMeshes(base: readonly MeshData[], idOffset: number, paintedId: number, rgb: [number, number, number]): MeshData[] {
  const rgba = new Uint8Array(4 * 4);
  for (let i = 0; i < 4; i++) rgba.set([...rgb, 255], i * 4);
  return base.map((m) => {
    const copy: MeshData = { ...m, positions: m.positions.slice(), normals: m.normals.slice(), indices: m.indices.slice() };
    if (m.expressId === paintedId) {
      const vertexCount = m.positions.length / 3;
      copy.uvs = new Float32Array(vertexCount * 2);
      copy.texture = { width: 2, height: 2, rgba, repeatS: false, repeatT: true };
    }
    applyFederationOffsetToMesh(copy, idOffset);
    return copy;
  });
}

describe('two copies of AC20-FZK-Haus.ifc in one room (#4444)', () => {
  it('owner → fresh guest → rejoin: two slots, two models, two textures, correct picking', async (t) => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'models', 'manifest.json'), 'utf8')) as {
      files: { path: string }[];
    };
    assert.ok(
      manifest.files.some((f) => `tests/models/${f.path}` === FIXTURE),
      `${FIXTURE} is not in tests/models/manifest.json, so CI would never fetch it`,
    );
    if (!existsSync(join(REPO_ROOT, FIXTURE)) || !existsSync(join(REPO_ROOT, WASM))) {
      t.skip('run pnpm fixtures and pnpm build:wasm for the real two-copy room contract');
      return;
    }

    const file = readFileSync(join(REPO_ROOT, FIXTURE));
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    // Two parses, not one store reused: two loaded files are two stores.
    const storeA = await parseStore(bytes.slice());
    const storeB = await parseStore(bytes.slice());
    const processor = new GeometryProcessor();
    let baseMeshes: MeshData[];
    try {
      await processor.init();
      baseMeshes = (await processor.process(bytes.slice())).meshes;
    } finally {
      processor.dispose();
    }
    assert.ok(baseMeshes.length > 100, `the fixture tessellates (${baseMeshes.length} meshes)`);
    const entityCount = storeA.entityIndex.byId.size;
    assert.equal(storeB.entityIndex.byId.size, entityCount);

    // The member both appearance sources target: the first wall with a mesh.
    const painted = baseMeshes.find((m) => storeA.entities.getTypeName(m.expressId) === 'IfcWallStandardCase') ?? baseMeshes[0];
    const paintedGuid = storeA.entities.getGlobalId(painted.expressId);
    assert.ok(paintedGuid, 'the painted member has a GlobalId');
    const sourceGuids = new Set<string>();
    for (const id of storeA.entityIndex.byId.keys()) {
      const guid = storeA.entities.getGlobalId(id);
      if (guid) sourceGuids.add(guid);
    }
    const B_OFFSET = 1_000_000;

    const models: CollabSeedModel[] = [
      { modelId: 'A', name: 'AC20-FZK-Haus.ifc', store: storeA, isIfcx: false, meshes: copyMeshes(baseMeshes, 0, painted.expressId, [255, 0, 0]), idOffset: 0, schemaVersion: 'IFC4', fileName: 'AC20-FZK-Haus.ifc' },
      { modelId: 'B', name: 'AC20-FZK-Haus.ifc', store: storeB, isIfcx: false, meshes: copyMeshes(baseMeshes, B_OFFSET, painted.expressId, [0, 0, 255]), idOffset: B_OFFSET, schemaVersion: 'IFC4', fileName: 'AC20-FZK-Haus.ifc' },
    ];
    const roomModels = new Map<string, ModelSlotRef>([
      ['A', roomSlotRef(0)],
      ['B', roomSlotRef(1)],
    ]);

    // ── Owner ──
    const doc = collab.createCollabDoc();
    const blobStore = new collab.MemoryBlobStore();
    // One websocket frame per doc update: the two-copy seed must not send one
    // per entity, or a relay's write budget drops the second copy's geometry
    // (see owner-seed.frames.test.ts for the transaction structure pinned here).
    let frames = 0;
    doc.on('update', () => {
      frames += 1;
    });
    const { outcome, phases } = await ownerShare(doc, blobStore, models, roomModels);
    assert.deepEqual(outcome, { phase: 'ready', failure: null });
    assert.equal(frames, 9, 'slot record, structure, mesh resolve and geometry per slot, then the marker');
    assert.deepEqual(phases, ['structure', 'geometry', 'structure', 'geometry']);
    assert.deepEqual(collab.listModelSlots(doc).map((s) => [s.slotId, s.name]), [['m0', 'AC20-FZK-Haus.ifc'], ['m1', 'AC20-FZK-Haus.ifc']]);
    const slotEntities = (slot: string) => Array.from(collab.entitiesMap(doc).keys()).filter((p) => p.startsWith(`/${slot}/`)).length;
    assert.ok(slotEntities('m0') > 0);
    assert.equal(slotEntities('m1'), slotEntities('m0'), 'every seeded entity of copy A exists in copy B');
    assert.equal(collab.entitiesMap(doc).size, 2 * slotEntities('m0'), 'nothing merged across the copies');
    const marker = readGeometrySeedMarker(doc);
    assert.equal(marker?.seeded, marker?.expected, 'every offered mesh landed');
    assert.equal(marker?.expected, 2 * baseMeshes.length);
    // What a guest can hydrate per slot: every (entity, geomId) ref. Fewer
    // than the meshes offered when one entity carries byte-identical
    // representation items — `addGeometryRef` keeps one ref per content
    // hash per entity, which is the room's contract for a single model too.
    const slotRefs = (slot: string) => {
      let refs = 0;
      for (const path of collab.entitiesMap(doc).keys()) {
        if (path.startsWith(`/${slot}/`)) refs += collab.getGeometryRef(doc, path)?.geomIds.length ?? 0;
      }
      return refs;
    };
    const refsPerSlot = slotRefs('m0');
    assert.equal(slotRefs('m1'), refsPerSlot, 'copy B carries exactly the refs copy A does');
    assert.ok(refsPerSlot > 100 && refsPerSlot <= baseMeshes.length);
    t.diagnostic(
      `AC20 x2: entities/slot=${slotEntities('m0')} room entities=${collab.entitiesMap(doc).size} ` +
        `meshes offered/copy=${baseMeshes.length} refs/slot=${refsPerSlot} geometry records=${doc.getMap('geometry').size} ` +
        `blobs=${marker?.seeded} doc update frames=${frames}`,
    );
    const refA = collab.getGeometryRef(doc, `/m0/${paintedGuid}`);
    const refB = collab.getGeometryRef(doc, `/m1/${paintedGuid}`);
    assert.ok(refA && refB);
    assert.notDeepEqual(refA.geomIds, refB.geomIds, 'the painted member points at a different blob in each copy');

    // ── Fresh guest ──
    const guest = joiner(doc, blobStore, 'ac20');
    await guest.reconstructor.reconstruct();
    const check = (label: string, s: RoomTestState) => {
      assert.deepEqual(Array.from(s.models.keys()).sort(), ['room:ac20:m0', 'room:ac20:m1'], label);
      const a = s.models.get('room:ac20:m0')!;
      const b = s.models.get('room:ac20:m1')!;
      assert.ok(b.idOffset > a.idOffset + a.maxExpressId, `${label}: disjoint global-id ranges`);
      assert.equal(a.geometryResult?.meshes.length, refsPerSlot, `${label}: copy A hydrated every ref`);
      assert.equal(b.geometryResult?.meshes.length, refsPerSlot, `${label}: copy B hydrated every ref`);
      const wallA = localIdOf(a, `/m0/${paintedGuid}`);
      const wallB = localIdOf(b, `/m1/${paintedGuid}`);
      const meshA = a.geometryResult!.meshes.find((m) => m.expressId === a.idOffset + wallA);
      const meshB = b.geometryResult!.meshes.find((m) => m.expressId === b.idOffset + wallB);
      assert.ok(meshA && meshB, `${label}: the painted member renders in both copies`);
      assert.deepEqual(texturePixel(meshA), [255, 0, 0], `${label}: copy A keeps its red appearance`);
      assert.deepEqual(texturePixel(meshB), [0, 0, 255], `${label}: copy B keeps its blue appearance`);
      // Picking: the mesh's global id names its own model, never the other copy.
      assert.deepEqual(s.resolveGlobalIdFromModels(meshA.expressId), { modelId: 'room:ac20:m0', expressId: wallA });
      assert.deepEqual(s.resolveGlobalIdFromModels(meshB.expressId), { modelId: 'room:ac20:m1', expressId: wallB });
      // Room export, as the Export dialog's IFC5 branch runs it per selected
      // model (merged export is STEP-only): both room models export, each
      // carrying only its own copy's meshes, the painted member's texture
      // included. The recipient's store keys entities by slot-qualified room
      // path, and the dialog un-homes them (`roomExportPathPrefix` →
      // `stripPathPrefix`): the file carries `/<GlobalId>` — the paths a
      // single-model room has always exported — never the room's slot.
      const exported: { paths: Set<string>; nodes: Map<string, string>; carriers: string; meshCount: number }[] = [];
      for (const [m, wallLocal] of [[a, wallA], [b, wallB]] as const) {
        assert.ok(m.ifcDataStore && m.schemaVersion, `${label}: ${m.id} is exportable on its own`);
        const stripPathPrefix = roomExportPathPrefix(s, m.id);
        assert.equal(stripPathPrefix, `/${s.collabRoomModels.get(m.id)?.slotId}`, `${label}: ${m.id} exports without its slot`);
        const result = new Ifc5Exporter(m.ifcDataStore, m.geometryResult, undefined, m.idOffset).export({
          includeGeometry: true,
          includeProperties: true,
          applyMutations: true,
          visibleOnly: false,
          onlyKnownProperties: false,
          author: 'ifc-lite',
          stripPathPrefix,
        });
        // The exporter's spatial-tree filter (the dialog's default) keeps
        // contained elements only, so this is fewer than the hydrated refs —
        // the same for both copies, and the same as the owner's own export.
        assert.ok(result.stats.meshCount > 0, `${label}: ${m.id} exports geometry`);
        const file = JSON.parse(result.content) as {
          data: { path: string; children?: Record<string, string>; attributes?: Record<string, unknown> }[];
        };
        // The recipient's own key for the wall is the room path; the file's is not.
        assert.equal(m.ifcDataStore.entities.getGlobalId(wallLocal), `${stripPathPrefix}/${paintedGuid}`);
        const wallNode = file.data.find((n) => n.path === `/${paintedGuid}`);
        assert.ok(wallNode, `${label}: ${m.id} exports the painted member at /${paintedGuid}`);
        // A textured member is written as appearance fragments under the node.
        const fragmentPaths = new Set(Object.values(wallNode.children ?? {}));
        const fragments = file.data.filter((n) => fragmentPaths.has(n.path));
        assert.ok(
          fragments.some((n) => n.attributes?.[IFCX_APPEARANCE] !== undefined),
          `${label}: ${m.id} exports the painted member's texture`,
        );
        // Every entity path in the file is a GlobalId of the SOURCE model (a
        // leading slash, as every room export carries), so the export diffs
        // against the file the owner loaded; the slot appears nowhere.
        const entityPaths = new Set<string>();
        const nodes = new Map<string, string>();
        const carriers: unknown[] = [];
        for (const n of file.data) {
          if (!n.path.startsWith('/')) {
            // The document root and the appearance/image carriers (`ifclite-mesh-*`, `ifclite-image-*`).
            if (n.attributes?.[IFCX_APPEARANCE] !== undefined || n.attributes?.[IFCX_IMAGE] !== undefined) carriers.push(n.attributes);
            continue;
          }
          entityPaths.add(n.path);
          nodes.set(n.path, JSON.stringify({ children: n.children ?? null, attributes: n.attributes ?? null }));
          assert.doesNotMatch(n.path, /^\/m\d+\//, `${label}: ${m.id} leaks its slot into ${n.path}`);
          assert.ok(sourceGuids.has(n.path.slice(1)), `${label}: ${m.id} exports ${n.path}, which the source model has no GlobalId for`);
          for (const child of Object.values(n.children ?? {})) {
            assert.doesNotMatch(child, /^\/m\d+\//, `${label}: ${m.id} leaks its slot into a child reference ${child}`);
          }
        }
        assert.ok(carriers.length > 0, `${label}: ${m.id} writes its texture carriers`);
        exported.push({ paths: entityPaths, nodes, carriers: JSON.stringify(carriers), meshCount: result.stats.meshCount });
      }
      assert.deepEqual(exported[0].paths, exported[1].paths, `${label}: both copies export the same node paths`);
      assert.equal(exported[0].meshCount, exported[1].meshCount, `${label}: both copies export the same mesh set`);
      // The two files differ only where the copies differ — the pixels of the
      // painted member's texture: every entity node (path, children,
      // attributes, the wall's fragment reference included) is identical.
      const differing = [...exported[0].paths].filter((path) => exported[0].nodes.get(path) !== exported[1].nodes.get(path));
      assert.deepEqual(differing, [], `${label}: the copies' entity nodes are identical`);
      assert.notEqual(exported[0].carriers, exported[1].carriers, `${label}: the copies carry different textures`);
    };
    check('fresh guest', guest.store.state());
    assert.deepEqual(guest.notices, [], 'no missing-geometry warning');

    // ── Rejoin ──
    guest.reconstructor.teardown();
    assert.equal(guest.store.state().models.size, 0, 'leaving drops both room models');
    const again = joiner(doc, blobStore, 'ac20');
    await again.reconstructor.reconstruct();
    check('rejoin', again.store.state());
    again.reconstructor.teardown();
  });
});
