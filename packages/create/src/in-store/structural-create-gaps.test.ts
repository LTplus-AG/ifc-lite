/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { IfcParser, EntityExtractor, extractStructuralOnDemand } from '@ifc-lite/parser';
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
      const extractor = new EntityExtractor(parsed.source);
      const originalAspect = extractor.extractEntity(parsed.entityIndex.byId.get(done.get('surface-stations'))!)!;
      const originalMember = extractor.extractEntity(parsed.entityIndex.byId.get(done.get('surface-member'))!)!;
      const varyingMember = extractor.extractEntity(parsed.entityIndex.byId.get(done.get('varying-surface-member'))!)!;
      const aspectId = Number(varyingMember.attributes[10]);
      expect(aspectId).not.toBe(done.get('surface-stations'));
      const aspect = extractor.extractEntity(parsed.entityIndex.byId.get(aspectId)!)!;
      expect(aspect.attributes[4]).toBe(varyingMember.attributes[6]);
      expect(originalAspect.attributes[4]).toBe(originalMember.attributes[6]);
      const sourceReps = originalAspect.attributes[0] as number[];
      const copiedReps = aspect.attributes[0] as number[];
      expect(copiedReps).toHaveLength(3);
      for (let i = 0; i < copiedReps.length; i++) {
        expect(copiedReps[i]).not.toBe(sourceReps[i]);
        const source = extractor.extractEntity(parsed.entityIndex.byId.get(sourceReps[i])!)!;
        const copied = extractor.extractEntity(parsed.entityIndex.byId.get(copiedReps[i])!)!;
        expect(copied.attributes[3]).toEqual(source.attributes[3]);
      }
      expect(text).toContain(`(0.3,0.4),#${aspectId}`);
      const planar = editor.getNewEntity(done.get('varying-Planar'))!;
      const loadRefs = planar.attributes[13] as string[];
      expect(new Set(loadRefs).size).toBe(2);
      expect(text).toContain(`#${done.get('stations')},(${loadRefs.join(',')})`);
      expect(text).toContain(`${loadRefs[0]}=IFCSTRUCTURALLOADPLANARFORCE($,$,$,-3.)`);
      expect(text).toContain(`${loadRefs[1]}=IFCSTRUCTURALLOADPLANARFORCE($,$,$,-4.)`);
    } else {
      expect(text).toContain(`#${done.get('load-configuration')},.GLOBAL_COORDS.`);
      const linearLoad = Number(String(editor.getNewEntity(done.get('linear-action'))!.attributes[7]).slice(1));
      expect(text).toContain(`(#${linearLoad},#${done.get('configuration-second-load')}),((0.),(1.))`);
      expect(text).toContain(`#${linearLoad}=IFCSTRUCTURALLOADLINEARFORCE('Probe line force',$,$,-2.5,$,$,$)`);
      expect(text).toContain(`#${done.get('configuration-second-load')}=IFCSTRUCTURALLOADLINEARFORCE('Configuration end force',$,$,-7.5,$,$,$)`);
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
  it.each(['IFC4', 'IFC4X3'] as const)('%s validates configuration uniqueness and distribution samples (#9860)', async schema => {
    const { editor, anchor, store } = await fresh(schema);
    const load = create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -2 }).loadId;
    const point = create.addStructuralPointReactionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadSingleForce', ForceZ: 1 } }).loadId;
    const config = (Values: number[], Locations: number[][]) => create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcStructuralLoadConfiguration', Values, Locations });
    let before = editor.getMutationView().getNewEntities().length;
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: point })).toThrow(/point loads require a DISCRETE configuration/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(before);
    expect(() => config([load, load], [[0], [0]])).toThrow(/unique/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(before);
    const one = config([load], [[0]]), two = config([load, load], [[0], [1]]);
    const three = config([load, load, load], [[0], [1], [2]]);
    const backwards = config([load, load], [[1], [0]]);
    const twoDimensions = config([load, load], [[0, 0], [1, 1]]);
    const mixed = config([load, point], [[0], [1]]);
    const points = config([point, point], [[0], [1]]);
    const unlocated = create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcStructuralLoadConfiguration', Values: [load, load] });
    before = editor.getMutationView().getNewEntities().length;
    for (const PredefinedType of ['LINEAR', 'POLYGONAL', 'DISCRETE'] as const) {
      expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: load, PredefinedType })).toThrow(/requires IfcStructuralLoadConfiguration/);
      expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: one, PredefinedType })).toThrow(/sample count/);
    }
    for (const PredefinedType of ['CONST', 'SINUS', 'PARABOLA'] as const) expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: two, PredefinedType })).toThrow(/must not use/);
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: three, PredefinedType: 'LINEAR' })).toThrow(/sample count/);
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: two, PredefinedType: 'POLYGONAL' })).toThrow(/sample count/);
    for (const AppliedLoad of [backwards, twoDimensions]) expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad, PredefinedType: 'LINEAR' })).toThrow(/one-dimensional/);
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: mixed, PredefinedType: 'LINEAR' })).toThrow(/same entity type/);
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: points, PredefinedType: 'LINEAR' })).toThrow(/point loads require DISCRETE/);
    for (const PredefinedType of [undefined, 'NOTDEFINED', 'USERDEFINED'] as const) {
      expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: points, PredefinedType, ObjectType: 'Custom' })).toThrow(/point loads require DISCRETE/);
      expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: mixed, PredefinedType, ObjectType: 'Custom' })).toThrow(/same entity type/);
      for (const AppliedLoad of [backwards, twoDimensions, unlocated]) expect(() => create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad, PredefinedType, ObjectType: 'Custom' })).toThrow(/one-dimensional/);
    }
    expect(editor.getMutationView().getNewEntities()).toHaveLength(before);
    const unspecified = create.addStructuralCurveActionToStore(editor, anchor, { AppliedLoad: two });
    // Borrowed source configurations need the same validation after a reload.
    const content = new StepExporter(store, editor.getMutationView()).export({ schema, applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const exported = new EntityExtractor(parsed.source).extractEntity(parsed.entityIndex.byId.get(unspecified)!)!;
    expect(exported.attributes[11]).toBe('.NOTDEFINED.');
    const sourceEditor = new StoreEditor(parsed, new MutablePropertyView(null, 'source'));
    expect(() => create.addStructuralCurveActionToStore(sourceEditor, anchor, { AppliedLoad: one, PredefinedType: 'LINEAR' }, parsed)).toThrow(/sample count/);
    sourceEditor.setPositionalAttribute(one, 1, [`#${load}`, `#${load}`]);
    expect(() => create.addStructuralCurveActionToStore(sourceEditor, anchor, { AppliedLoad: one, PredefinedType: 'LINEAR' }, parsed)).toThrow(/Locations/);
    create.addStructuralCurveActionToStore(sourceEditor, anchor, { AppliedLoad: two, PredefinedType: 'LINEAR' }, parsed);
    const output = new TextDecoder().decode(new StepExporter(parsed, sourceEditor.getMutationView()).export({ schema, applyMutations: true }).content);
    expect(output).toContain(`#${two},.GLOBAL_COORDS.,$,$,.LINEAR.`);
  });

  it('IFC2X3 validates station counts and initial thickness before emitting entities (#9860)', async () => {
    const { editor, anchor, store } = await fresh('IFC2X3');
    const surface = create.addStructuralSurfaceMemberToStore(editor, anchor, { Boundary: [[0,0,0],[3,0,0],[0,3,0]], Thickness: 0.2 });
    const aspect = (count: number) => {
      const reps = Array.from({ length: count }, (_, i) => {
        const position = count === 3 ? [[0,0,0],[3,0,0],[0,3,0]][i] : [i,0,0];
        const point = editor.addEntity('IfcCartesianPoint', [position]).expressId;
        return `#${editor.addEntity('IfcShapeRepresentation', [`#${anchor.axisContextId}`, 'Reference', 'Point', [`#${point}`]]).expressId}`;
      });
      return editor.addEntity('IfcShapeAspect', [reps, null, null, true, `#${surface.productShapeId}`]).expressId;
    };
    const one = aspect(1), two = aspect(2), three = aspect(3);
    const line = create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -1 }).loadId;
    const planar = create.addStructuralPlanarActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -1 } }).loadId;
    const before = editor.getMutationView().getNewEntities().length;
    const locations = editor.getNewEntity(two)!.attributes[0] as string[];
    editor.setPositionalAttribute(two, 0, locations.slice(0, 1));
    expect(() => create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -2, VaryingAppliedLoadLocation: two, SubsequentAppliedLoads: [line] })).toThrow(/one location per applied load/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(before);
    editor.setPositionalAttribute(two, 0, locations);
    expect(() => create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -2, VaryingAppliedLoadLocation: one, SubsequentAppliedLoads: [line] })).toThrow(/one location per applied load/);
    expect(() => create.addStructuralPlanarActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -2 }, VaryingAppliedLoadLocation: two, SubsequentAppliedLoads: [planar, planar] })).toThrow(/one location per applied load/);
    expect(() => create.addStructuralSurfaceMemberToStore(editor, anchor, { Type: 'IfcStructuralSurfaceMemberVarying', Boundary: [[0,0,0],[3,0,0],[0,3,0]], SubsequentThickness: [0.3, 0.4], VaryingThicknessLocation: three })).toThrow(/requires Thickness/);
    expect(() => create.addStructuralSurfaceMemberToStore(editor, anchor, { Type: 'IfcStructuralSurfaceMemberVarying', Boundary: [[0,0,0],[3,0,0],[0,3,0]], Thickness: 0.2, SubsequentThickness: [0.3, 0.4], VaryingThicknessLocation: two })).toThrow(/one representation per thickness/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(before);
    const content = new StepExporter(store, editor.getMutationView()).export({ schema: 'IFC2X3', applyMutations: true }).content;
    const parsed = await new IfcParser().parseColumnar(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const sourceEditor = new StoreEditor(parsed, new MutablePropertyView(null, 'source'));
    expect(() => create.addStructuralLinearActionToStore(sourceEditor, anchor, { LinearForceZ: -2, VaryingAppliedLoadLocation: one, SubsequentAppliedLoads: [line] }, parsed)).toThrow(/one location per applied load/);
    sourceEditor.setPositionalAttribute(one, 0, editor.getNewEntity(two)!.attributes[0]);
    create.addStructuralLinearActionToStore(sourceEditor, anchor, { LinearForceZ: -2, VaryingAppliedLoadLocation: one, SubsequentAppliedLoads: [line] }, parsed);
    create.addStructuralLinearActionToStore(sourceEditor, anchor, { LinearForceZ: -2, VaryingAppliedLoadLocation: two, SubsequentAppliedLoads: [line] }, parsed);
    expect(new TextDecoder().decode(new StepExporter(parsed, sourceEditor.getMutationView()).export({ schema: 'IFC2X3', applyMutations: true }).content)).toContain(`#${two},(#${line})`);
    const varying = create.addStructuralSurfaceMemberToStore(sourceEditor, anchor, { Type: 'IfcStructuralSurfaceMemberVarying', Boundary: [[0,0,0],[3,0,0],[0,3,0]], Thickness: 0.2, SubsequentThickness: [0.3, 0.4], VaryingThicknessLocation: three }, parsed);
    const updated = new StepExporter(parsed, sourceEditor.getMutationView()).export({ schema: 'IFC2X3', applyMutations: true }).content;
    const reopened = await new IfcParser().parseColumnar(updated.buffer.slice(updated.byteOffset, updated.byteOffset + updated.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const extractor = new EntityExtractor(reopened.source);
    const original = extractor.extractEntity(reopened.entityIndex.byId.get(three)!)!;
    const member = extractor.extractEntity(reopened.entityIndex.byId.get(varying.memberId)!)!;
    const copyId = Number(member.attributes[10]);
    expect(copyId).not.toBe(three);
    expect(extractor.extractEntity(reopened.entityIndex.byId.get(copyId)!)!.attributes[4]).toBe(member.attributes[6]);
    expect(original.attributes[4]).toBe(surface.productShapeId);
  });

  it.each(['IFC4', 'IFC4X3'] as const)('%s storeless configuration validation observes pending edits (#9860 discussion_r4550397254)', async schema => {
    const { editor, anchor, store, view } = await fresh(schema);
    const load = create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -2 }).loadId;
    const config = create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcStructuralLoadConfiguration', Values: [load, load], Locations: [[0], [1]] });
    const params = { AppliedLoad: config, PredefinedType: 'LINEAR' as const };
    const before = view.getNewEntities().length;
    view.setAttribute(config, 'Values', `(#${load})`);
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, params)).toThrow(/sample count/);
    expect(view.getNewEntities()).toHaveLength(before);
    // Positional edits override named edits, exactly as they do in STEP export.
    editor.setPositionalAttribute(config, 1, [`#${load}`, `#${load}`]);
    editor.setPositionalAttribute(config, 2, [[{ real: 0 }]]);
    expect(() => create.addStructuralCurveActionToStore(editor, anchor, params)).toThrow(/Locations/);
    expect(view.getNewEntities()).toHaveLength(before);
    editor.setPositionalAttribute(config, 2, [[{ real: 0 }], [{ real: 1 }]]);
    const action = create.addStructuralCurveActionToStore(editor, anchor, params);
    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema, applyMutations: true }).content);
    expect(text).toContain(`#${action}=IFCSTRUCTURALCURVEACTION(`);
    expect(text).toContain(`(#${load},#${load}),((0.),(1.))`);
  });

  it('rejects supplied malformed connection points and condition objects atomically (#9860 discussion_r4550515863)', async () => {
    const { editor, anchor, view } = await fresh('IFC4');
    const member = create.addStructuralCurveMemberToStore(editor, anchor, { Start: [0,0,0], End: [2,0,0] }).memberId;
    const connection = create.addStructuralPointConnectionToStore(editor, anchor, { Position: [0,0,0] }).connectionId;
    const before = view.getNewEntities().length;
    for (const value of [false, 0, '', null]) {
      const PointOnRelatedElement = value as unknown as [number, number, number];
      expect(() => create.connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, member, connection, undefined, {
        ConnectionConstraint: { PointOnRelatingElement: [0,0,0], PointOnRelatedElement, EccentricityInX: 0.1, EccentricityInY: 0, EccentricityInZ: 0 },
      })).toThrow(/finite points/);
      for (const key of ['AdditionalConditions', 'ConnectionConstraint']) {
        const options = { [key]: value } as unknown as Parameters<typeof create.connectStructuralMemberToConnectionInStore>[5];
        expect(() => create.connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, member, connection, undefined, options)).toThrow(/must be .*object/);
      }
      expect(view.getNewEntities()).toHaveLength(before);
    }
    const relationship = create.connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, member, connection, undefined, {
      ConnectionConstraint: { PointOnRelatingElement: [0,0,0], EccentricityInX: 0.1, EccentricityInY: 0, EccentricityInZ: 0 },
    });
    expect(editor.getEntityType(relationship)).toBe('IfcRelConnectsWithEccentricity');
  });

});
