/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { IfcParser, extractStructuralOnDemand } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
// The export barrel also exports geometry processors; this schema-only suite
// intentionally loads the STEP writer without requiring a WASM runtime.
import { StepExporter } from '../../../export/src/step-exporter.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addBeamToStore } from './beam.js';
import { addStructuralAnalysisModelToStore } from './structural-analysis-model.js';
import { addStructuralCurveActionToStore } from './structural-curve-action.js';
import { addStructuralCurveConnectionToStore } from './structural-curve-connection.js';
import { addStructuralCurveMemberToStore } from './structural-curve-member.js';
import { addStructuralCurveReactionToStore, addStructuralPointReactionToStore, addStructuralSurfaceReactionToStore } from './structural-reaction.js';
import { addStructuralLinearActionToStore, addStructuralPointActionToStore } from './structural-action.js';
import { addStructuralLoadGroupToStore } from './structural-load-group.js';
import { addStructuralLoadToStore } from './structural-load.js';
import { addStructuralPlanarActionToStore, addStructuralSurfaceActionToStore } from './structural-surface-action.js';
import { addStructuralPointConnectionToStore } from './structural-point-connection.js';
import { addStructuralResultGroupToStore } from './structural-result-group.js';
import { addStructuralSurfaceConnectionToStore } from './structural-surface-connection.js';
import { addStructuralSurfaceMemberToStore } from './structural-surface-member.js';
import { assignToStructuralGroupInStore, connectStructuralActivityToItemInStore, connectStructuralMemberToConnectionInStore } from './structural-relationships.js';
import { connectStructuralElementInStore } from './structural-physical-link.js';
const create = {
  resolveSpatialAnchor,
  addBeamToStore,
  addStructuralAnalysisModelToStore,
  addStructuralCurveActionToStore,
  addStructuralCurveConnectionToStore,
  addStructuralCurveMemberToStore,
  addStructuralCurveReactionToStore, addStructuralPointReactionToStore, addStructuralSurfaceReactionToStore,
  addStructuralLinearActionToStore, addStructuralPointActionToStore,
  addStructuralLoadGroupToStore,
  addStructuralLoadToStore,
  addStructuralPlanarActionToStore, addStructuralSurfaceActionToStore,
  addStructuralPointConnectionToStore,
  addStructuralResultGroupToStore,
  addStructuralSurfaceConnectionToStore,
  addStructuralSurfaceMemberToStore,
  assignToStructuralGroupInStore, connectStructuralActivityToItemInStore, connectStructuralMemberToConnectionInStore,
  connectStructuralElementInStore,
};

const ROOT = resolve(__dirname, '../../../..');
const scenePath = join(ROOT, 'tests/structural-coverage/probes/create-scene.mjs');
const { blankModel, stepsFor } = await import(scenePath);
const PYTHON = process.env.IFCOPENSHELL_PYTHON ?? 'python3';
const canValidate = spawnSync(PYTHON, ['-c', 'import ifcopenshell, pytest'], { stdio: 'ignore' }).status === 0;
if (!canValidate) console.warn('SKIPPED structural CREATE IfcOpenShell validation: install ifcopenshell + pytest or set IFCOPENSHELL_PYTHON');

async function fresh(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3') {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(blankModel(schema)).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'gaps');
  const editor = new StoreEditor(store, view);
  const anchor = create.resolveSpatialAnchor(store, 45, view);
  return { store, view, editor, anchor };
}

// #9668: execute the actual coverage scene, including the new builder variants.
describe('structural CREATE gaps (#9668)', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s exports all scene steps and preserves resource references', async schema => {
    const { store, view, editor, anchor } = await fresh(schema);
    const done = new Map();
    for (const step of stepsFor(schema)) done.set(step.id, step.build({ create, editor, anchor, done }));
    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema, applyMutations: true }).content);
    const parsed = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
    expect(parsed.entityCount).toBeGreaterThan(store.entityCount);
    // #9860 discussion_r4550074151: applied loads and computed results must
    // remain distinct after export, including the newly added reactions.
    const data = extractStructuralOnDemand(parsed);
    const actions = data.activities.filter(a => a.kind === 'Action').map(a => a.globalId).sort();
    const reactions = data.activities.filter(a => a.kind === 'Reaction').map(a => a.globalId).sort();
    expect(actions.length).toBeGreaterThan(0);
    expect(reactions.length).toBeGreaterThan(0);
    expect(data.loadGroups.find(g => g.expressId === done.get('load-group'))?.activityGlobalIds.slice().sort()).toEqual(actions);
    expect(data.resultGroups.find(g => g.expressId === done.get('result-group'))?.activityGlobalIds.slice().sort()).toEqual(reactions);
    // These references are borrowed; the exporter must retain their exact targets.
    if (schema === 'IFC2X3') {
      expect(text).toContain(`#${done.get('stations')},(`);
      expect(text).toContain(`(0.3,0.4),#${done.get('stations')}`);
    } else {
      expect(text).toContain(`#${done.get('load-configuration')},.GLOBAL_COORDS.`);
      expect(text).toContain(`(#${done.get('IfcStructuralLoadSingleForceWarping')},#${done.get('IfcStructuralLoadSingleForceWarping')}),((0.),(1.))`);
    }
    if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(join(process.env.STRUCTURAL_EXPORT_DIR, `${schema}-create-gaps.ifc`), text);
    if (canValidate) {
      const dir = mkdtempSync(join(tmpdir(), 'structural-create-'));
      try {
        const path = join(dir, 'scene.ifc');
        writeFileSync(path, text);
        const result = spawnSync(PYTHON, [join(ROOT, 'tools/ifcopenshell_reference/validate_export.py'), path], { encoding: 'utf8', timeout: 55_000 });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 60_000);

  it.each(['IFC4', 'IFC4X3'] as const)('%s refuses IFC2X3-only variants before mutation', async schema => {
    const { editor, anchor } = await fresh(schema);
    expect(() => create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -2, SubsequentAppliedLoads: [1], VaryingAppliedLoadLocation: 1 })).toThrow(/only in IFC2X3/);
    expect(() => create.connectStructuralElementInStore(editor, 5, 1, 2)).toThrow(/only in IFC2X3/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });
  it('IFC2X3 refuses modern resources and incomplete varying actions atomically', async () => {
    const { editor, anchor } = await fresh('IFC2X3');
    expect(() => create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcStructuralLoadConfiguration', Values: [1] })).toThrow(/unsupported schema/);
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: 1 })).toThrow(/unsupported schema/);
    expect(() => create.addStructuralPlanarActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -1 }, SubsequentAppliedLoads: [1], VaryingAppliedLoadLocation: 1 })).toThrow(/supply/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });
  it('refuses invalid configurations, reinforcement and connection data atomically', async () => {
    const { editor, anchor } = await fresh('IFC4');
    expect(() => create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcSurfaceReinforcementArea', SurfaceReinforcement1: [-1, 2] })).toThrow(/nonnegative/);
    expect(() => create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcStructuralLoadConfiguration', Values: [] })).toThrow(/Values/);
    expect(() => create.connectStructuralMemberToConnectionInStore(editor, 5, 1, 2, undefined, { AdditionalConditions: { Type: 'IfcSlippageConnectionCondition', SlippageX: NaN } })).toThrow(/finite/);
    expect(() => create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: NaN })).toThrow(/finite/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });
});
