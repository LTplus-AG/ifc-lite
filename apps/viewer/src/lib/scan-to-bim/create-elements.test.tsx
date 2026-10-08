/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan-to-BIM creation round trip (#6894), on the canonical load path and the
 * real wasm engine: a real detection of the seeded room is created in a blank
 * IFC model (metres and millimetres, `models.size` 1 and 2) as one undo step,
 * exported, reopened through `loadFile`, and the reopened file is checked for
 * the classes, the GlobalIds, the provenance property set and the geometry
 * the proposals described.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { IfcCreator } from '@ifc-lite/create';
import { skip, blankFile, load, bounds } from '@/test/blank-ifc-loader-harness.js';
import { scanRoomSample } from '@/test/scan-room-fixture';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import type { ScanElementProposal } from '@ifc-lite/geometry/scan-proposals';
import { runScanDetectJob } from './detect-job';
import { createScanElements, SCAN_DETECTION_PSET } from './create-elements';

/** Y-up sample -> Z-up workspace world (the blank model has no offsets). */
const SWAP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

let detected: ScanElementProposal[] | null = null;
/** Once, after the harness has initialised the wasm engine. */
function detect(): ScanElementProposal[] {
  if (!detected) {
    const positions = scanRoomSample();
    detected = runScanDetectJob({ positions, count: positions.length / 3, region: null, scanToModel: SWAP, schema: 'IFC4' }).proposals.proposals;
  }
  return detected;
}

/** What each proposal's element must measure: axis-aligned extents in metres. */
function expectedExtent(p: ScanElementProposal): { min: number[]; max: number[] } | null {
  const g = p.geometry;
  if (g.kind === 'column') {
    const [x, y, z] = g.base;
    return { min: [x - g.radiusMetres, y - g.radiusMetres, z], max: [x + g.radiusMetres, y + g.radiusMetres, z + g.heightMetres] };
  }
  if (g.kind === 'slab') {
    const xs = g.outline.map((q) => q[0]), ys = g.outline.map((q) => q[1]), top = g.outline[0][2];
    return { min: [Math.min(...xs), Math.min(...ys), top - g.thicknessMetres], max: [Math.max(...xs), Math.max(...ys), top] };
  }
  if (g.kind === 'wall') {
    // The room's walls run along x or y, so the body's box is exact.
    const alongX = Math.abs(g.end[0] - g.start[0]) > Math.abs(g.end[1] - g.start[1]);
    const half = g.thicknessMetres / 2;
    const lo = [Math.min(g.start[0], g.end[0]), Math.min(g.start[1], g.end[1])];
    const hi = [Math.max(g.start[0], g.end[0]), Math.max(g.start[1], g.end[1])];
    return alongX
      ? { min: [lo[0], lo[1] - half, g.start[2]], max: [hi[0], hi[1] + half, g.start[2] + g.heightMetres] }
      : { min: [lo[0] - half, lo[1], g.start[2]], max: [hi[0] + half, hi[1], g.start[2] + g.heightMetres] };
  }
  return null;
}

describe('scan-to-BIM creation round trip (#6894)', () => {
  for (const unit of ['METRE', 'MILLIMETRE'] as const) {
    for (const count of [1, 2]) {
      it(`${unit}, ${count} model(s): accepted proposals become one undo step, export and reopen as the same elements`, { skip }, async () => {
        const proposals = detect();
        assert.equal(proposals.length, 7, 'four walls, two slabs, one column');
        const primary = await load(blankFile(unit));
        if (count === 2) await load(blankFile(unit), 'peer');
        const before = useViewerStore.getState().undoStacks.get(primary.id)?.length ?? 0;
        const outcome = createScanElements({ modelId: primary.id, proposals, scanName: 'room.e57' });
        assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
        assert.equal(outcome.created.length, 7);
        const ids = outcome.created.map((c) => c.expressId);
        assert.equal((await requestRemesh(useViewerStore.getState, primary.id, ids, 'created')).status, 'applied');

        // In the tree: every element is contained in the storey.
        const view = useViewerStore.getState().mutationViews.get(primary.id)!;
        const classes = ids.map((id) => view.getNewEntity(id)!.type.toUpperCase()).sort();
        assert.deepEqual(classes, ['IFCCOLUMN', 'IFCSLAB', 'IFCSLAB', 'IFCWALL', 'IFCWALL', 'IFCWALL', 'IFCWALL']);
        const storey = primary.ifcDataStore!.entityIndex.byType.get('IFCBUILDINGSTOREY')![0];
        assert.ok(outcome.created.every((c) => c.storeyId === storey));

        // One undo step removes the whole batch; one redo restores it.
        useViewerStore.getState().undo(primary.id);
        assert.ok(ids.every((id) => !view.getNewEntity(id) || view.isDeleted(id)), 'one undo removes every created element');
        assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length ?? 0, before);
        useViewerStore.getState().redo(primary.id);
        assert.ok(ids.every((id) => view.getNewEntity(id) && !view.isDeleted(id)), 'one redo restores them');

        // Export, then reopen through the canonical load path.
        const globalIds = new Map(ids.map((id, i) => [String(view.getNewEntity(id)!.attributes[0]), proposals[i]]));
        const bytes = editedModelBytes(primary.ifcDataStore!, view);
        const parsed = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
        const reopened = await load(new File([bytes.slice()], 'scan-to-bim.ifc'), 'reopened');
        const store = reopened.ifcDataStore!;
        let matched = 0;
        for (const type of ['IFCWALL', 'IFCSLAB', 'IFCCOLUMN']) {
          for (const id of store.entityIndex.byType.get(type) ?? []) {
            const proposal = globalIds.get(store.entities.getGlobalId(id));
            if (!proposal) continue;
            matched++;
            assert.equal(type, proposal.ifcClass.toUpperCase());
            // Provenance survives the export.
            const pset = extractPropertiesOnDemand(parsed, id).find((s) => s.name === SCAN_DETECTION_PSET);
            assert.ok(pset, `${proposal.id} keeps ${SCAN_DETECTION_PSET}`);
            assert.equal(pset.properties.find((q) => q.name === 'DetectionId')?.value, proposal.id);
            assert.equal(pset.properties.find((q) => q.name === 'SourceScan')?.value, 'room.e57');
            // Geometry: the reopened mesh spans what the proposal described.
            const gid = toGlobalIdFromModels(useViewerStore.getState().models, 'reopened', id);
            const meshes = reopened.geometryResult!.meshes.filter((m) => m.expressId === gid);
            assert.ok(meshes.length > 0, `${proposal.id} has a mesh after reopening`);
            const measured = bounds(meshes);
            const expected = expectedExtent(proposal)!;
            for (let a = 0; a < 3; a++) {
              assert.ok(Math.abs(measured.min[a] - expected.min[a]) < 2e-3, `${proposal.id} min[${a}] ${measured.min[a]} vs ${expected.min[a]}`);
              assert.ok(Math.abs(measured.max[a] - expected.max[a]) < 2e-3, `${proposal.id} max[${a}] ${measured.max[a]} vs ${expected.max[a]}`);
            }
          }
        }
        assert.equal(matched, 7, 'every created element reopens under its GlobalId');
      });
    }
  }

  for (const schema of ['IFC4', 'IFC2X3'] as const) {
    it(`${schema}: a pipe proposal becomes ${schema === 'IFC4' ? 'IfcPipeSegment' : 'IfcFlowSegment'} with a round body along its axis`, { skip }, async () => {
      const creator = new IfcCreator({ Name: 'Pipes', Schema: schema });
      creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
      const primary = await load(new File([creator.toIfc().content], 'pipes.ifc'));
      const ifcClass = schema === 'IFC4' ? 'IfcPipeSegment' : 'IfcFlowSegment';
      const pipe: ScanElementProposal = {
        id: 'pipe-0', ifcClass, confidence: 0.8, basis: 'cylinder', sources: [{ kind: 'cylinder', index: 0 }],
        fit: { rmsMetres: 0.003, inlierPoints: 900, inlierVoxels: 90, areaSquareMetres: 1 },
        geometry: { kind: 'pipe', start: [1, 3.2, 2.2], end: [4, 3.2, 2.2], radiusMetres: 0.08 },
      };
      const outcome = createScanElements({ modelId: primary.id, proposals: [pipe], scanName: 'room.e57' });
      assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
      const view = useViewerStore.getState().mutationViews.get(primary.id)!;
      const bytes = editedModelBytes(primary.ifcDataStore!, view);
      const reopened = await load(new File([bytes.slice()], 'pipes-out.ifc'), 'reopened');
      const ids = reopened.ifcDataStore!.entityIndex.byType.get(ifcClass.toUpperCase()) ?? [];
      assert.equal(ids.length, 1, `one ${ifcClass} after reopening`);
      const gid = toGlobalIdFromModels(useViewerStore.getState().models, 'reopened', ids[0]);
      const measured = bounds(reopened.geometryResult!.meshes.filter((m) => m.expressId === gid));
      for (const [a, lo, hi] of [[0, 1, 4], [1, 3.12, 3.28], [2, 2.12, 2.28]] as const) {
        assert.ok(Math.abs(measured.min[a] - lo) < 2e-3 && Math.abs(measured.max[a] - hi) < 2e-3, `axis ${a}: ${measured.min[a]}..${measured.max[a]}`);
      }
    });
  }

  it('a pipe takes the class of the model it is created in, not of the model it was detected for', { skip }, async () => {
    // Detected while an IFC4 model was active (IfcPipeSegment), created in an IFC2X3 one,
    // which has no IfcPipeSegment.
    const creator = new IfcCreator({ Name: 'Pipes', Schema: 'IFC2X3' });
    creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
    const primary = await load(new File([creator.toIfc().content], 'pipes-2x3.ifc'));
    const pipe: ScanElementProposal = {
      id: 'pipe-0', ifcClass: 'IfcPipeSegment', confidence: 0.8, basis: 'cylinder', sources: [{ kind: 'cylinder', index: 0 }],
      fit: { rmsMetres: 0.003, inlierPoints: 900, inlierVoxels: 90, areaSquareMetres: 1 },
      geometry: { kind: 'pipe', start: [1, 3.2, 2.2], end: [4, 3.2, 2.2], radiusMetres: 0.08 },
    };
    const outcome = createScanElements({ modelId: primary.id, proposals: [pipe], scanName: 'room.e57' });
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    const view = useViewerStore.getState().mutationViews.get(primary.id)!;
    const reopened = await load(new File([editedModelBytes(primary.ifcDataStore!, view).slice()], 'pipes-2x3-out.ifc'), 'reopened');
    assert.equal(reopened.ifcDataStore!.entityIndex.byType.get('IFCFLOWSEGMENT')?.length ?? 0, 1);
    assert.equal(reopened.ifcDataStore!.entityIndex.byType.get('IFCPIPESEGMENT')?.length ?? 0, 0);
  });

  it('each element goes to the storey it stands on, at its storey-local height', { skip }, async () => {
    const creator = new IfcCreator({ Name: 'Two storeys' });
    creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
    creator.addIfcBuildingStorey({ Name: 'Level 2', Elevation: 3 });
    const primary = await load(new File([creator.toIfc().content], 'two-storeys.ifc'));
    const fit = { rmsMetres: 0.003, inlierPoints: 900, inlierVoxels: 90, areaSquareMetres: 1 };
    const column = (id: string, z: number): ScanElementProposal => ({
      id, ifcClass: 'IfcColumn', confidence: 0.9, basis: 'cylinder', sources: [{ kind: 'cylinder', index: 0 }], fit,
      geometry: { kind: 'column', base: [1, 1, z], heightMetres: 2.6, radiusMetres: 0.2 },
    });
    // On level 1, on level 2, 0.2 m below level 2 (still level 2), and below every floor (the lowest storey).
    const proposals = [column('low', 0), column('high', 3), column('sunk', 2.8), column('basement', -1)];
    const outcome = createScanElements({ modelId: primary.id, proposals, scanName: 'room.e57' });
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
    const names = new Map(primary.ifcDataStore!.entityIndex.byType.get('IFCBUILDINGSTOREY')!.map((id) => [id, primary.ifcDataStore!.entities.getName(id)]));
    assert.deepEqual(outcome.created.map((c) => names.get(c.storeyId)), ['Level 1', 'Level 2', 'Level 2', 'Level 1']);
    const view = useViewerStore.getState().mutationViews.get(primary.id)!;
    const reopened = await load(new File([editedModelBytes(primary.ifcDataStore!, view).slice()], 'out.ifc'), 'reopened');
    const store = reopened.ifcDataStore!;
    const byGlobalId = new Map((store.entityIndex.byType.get('IFCCOLUMN') ?? []).map((id) => [store.entities.getGlobalId(id), id]));
    for (const [i, c] of outcome.created.entries()) {
      const id = byGlobalId.get(String(view.getNewEntity(c.expressId)!.attributes[0]))!;
      const gid = toGlobalIdFromModels(useViewerStore.getState().models, 'reopened', id);
      const measured = bounds(reopened.geometryResult!.meshes.filter((m) => m.expressId === gid));
      const z = (proposals[i].geometry as { base: number[] }).base[2];
      assert.ok(Math.abs(measured.min[2] - z) < 2e-3 && Math.abs(measured.max[2] - (z + 2.6)) < 2e-3, `${proposals[i].id}: ${measured.min[2]}..${measured.max[2]}`);
    }
  });

  it('refuses an empty batch, writing nothing', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const outcome = createScanElements({ modelId: primary.id, proposals: [], scanName: 'room.e57' });
    assert.deepEqual(outcome, { ok: false, reason: 'No accepted proposals to create.' });
    assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length ?? 0, 0);
  });
});
