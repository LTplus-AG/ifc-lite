/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as create from '../index.js';
import * as parser from '@ifc-lite/parser';
import * as mutations from '@ifc-lite/mutations';
import * as exporter from '@ifc-lite/export';
import { lifecycleScene } from '../../../../tests/structural-coverage/probes/lifecycle-scene.mjs';
const pkgs = { create, parser, mutations, exporter };
let sequence = 0;
const parse = (text: string) => {
  if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(`${process.env.STRUCTURAL_EXPORT_DIR}/lifecycle-${sequence++}.ifc`, text);
  return new parser.IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
};

// #9668: removal must operate on source-loaded entities as well as overlay creates.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s structural lifecycle #9668', schema => {
  it.each(['surface-member', 'curve-connection', 'surface-connection', 'curve-member', 'point-connection', 'point-action', 'linear-action', 'load-group', 'PlanarAction-PlanarForce', 'PlanarAction-Temperature', 'PointReaction-SingleForce', 'PointReaction-SingleDisplacement', 'result-group'])('%s returns to its pre-create entity count after a source reload', async step => {
    const scene = await lifecycleScene(pkgs, schema, step);
    const store = await parse(scene.exportText());
    const view = new mutations.MutablePropertyView(null, 'm');
    const editor = new mutations.StoreEditor(store, view);
    create.removeStructuralEntityInStore(store, editor, scene.id);
    const content = new exporter.StepExporter(store, view).export({ schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3', applyMutations: true }).content;
    const result = await parse(new TextDecoder().decode(content));
    expect(result.entityIndex.byId.size).toBe(scene.before.entities.size);
  });

  it.each(schema === 'IFC2X3' ? ['analysis-model-ifc2x3'] : ['analysis-model', 'load-case', 'SurfaceAction-PlanarForce', 'CurveReaction-LinearForce', 'SurfaceReaction-PlanarForce'])('%s removes on source reload', async step => {
    const scene = await lifecycleScene(pkgs, schema, step);
    const store = await parse(scene.exportText());
    const view = new mutations.MutablePropertyView(null, 'm');
    const editor = new mutations.StoreEditor(store, view);
    create.removeStructuralEntityInStore(store, editor, scene.id);
    const text = new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3', applyMutations: true }).content);
    expect((await parse(text)).entityIndex.byId.size).toBe(scene.before.entities.size);
  });

  it('keeps a vertex point shared by a different member geometry', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'curve-member');
    const firstShape = scene.editor.getNewEntities().find(e => e.type === 'IfcVertexPoint')!;
    const point = Number(String(firstShape.attributes[0]).slice(1));
    const second = create.addStructuralCurveMemberToStore(scene.editor, scene.anchor, { Start:[0,0,0], End:[2,0,0] });
    scene.editor.setPositionalAttribute(second.vertex1Id, 0, `#${point}`);
    const store = await parse(scene.exportText());
    const view = new mutations.MutablePropertyView(null, 'm');
    const editor = new mutations.StoreEditor(store, view);
    create.removeStructuralEntityInStore(store, editor, scene.id);
    const content = new exporter.StepExporter(store, view).export({ schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3', applyMutations: true }).content;
    const after = await parse(new TextDecoder().decode(content));
    expect(after.entityIndex.byId.has(point)).toBe(true);
    expect(parser.extractStructuralOnDemand(after).members.map(m => m.expressId)).toEqual([second.memberId]);
  });

  it('keeps an applied load reused by a second activity', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'point-action');
    const first = scene.editor.getNewEntity(scene.id)!;
    const attrs = [...first.attributes];
    attrs[0] = '0SecondActivity00000000';
    const second = scene.editor.addEntity(first.type, attrs).expressId;
    const member = create.addStructuralCurveMemberToStore(scene.editor, scene.anchor, { Start:[0,0,0], End:[1,0,0] }).memberId;
    create.connectStructuralActivityToItemInStore(scene.editor, scene.anchor.ownerHistoryId, member, second);
    create.removeStructuralEntityInStore(scene.store, scene.editor, scene.id);
    const data = parser.extractStructuralOnDemand(await parse(scene.exportText()));
    expect(data.activities).toHaveLength(1);
    expect(data.activities[0].appliedLoad?.components.ForceZ).toBe(-10);
  });

  it('keeps a boundary condition referenced by a second connection', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'point-connection');
    const first = scene.editor.getNewEntity(scene.id)!;
    const attrs = [...first.attributes];
    attrs[0] = '0SecondConnection000000';
    const second = scene.editor.addEntity(first.type, attrs).expressId;
    const member = create.addStructuralCurveMemberToStore(scene.editor, scene.anchor, { Start: [0,0,0], End: [1,0,0] }).memberId;
    create.connectStructuralMemberToConnectionInStore(scene.editor, scene.anchor.ownerHistoryId, member, second);
    create.removeStructuralEntityInStore(scene.store, scene.editor, scene.id);
    const data = parser.extractStructuralOnDemand(await parse(scene.exportText()));
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0].appliedCondition?.components).toBeDefined();
  });

  it('shrinks load-group membership without removing its other activity', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'point-action');
    const second = create.addStructuralPointActionToStore(scene.editor, scene.anchor, { ForceZ: -2 }).activityId;
    const member = scene.editor.getNewEntities().find(e => e.type === 'IfcStructuralCurveMember')!.expressId;
    create.connectStructuralActivityToItemInStore(scene.editor, scene.anchor.ownerHistoryId, member, second);
    const group = create.addStructuralLoadGroupToStore(scene.editor, scene.anchor, { ActionType:'PERMANENT_G', ActionSource:'DEAD_LOAD_G' }).loadGroupId;
    create.assignToStructuralGroupInStore(scene.editor, scene.anchor.ownerHistoryId, group, [scene.id, second]);
    create.removeStructuralEntityInStore(scene.store, scene.editor, scene.id);
    const data = parser.extractStructuralOnDemand(await parse(scene.exportText()));
    expect(data.loadGroups.find(g => g.expressId === group)?.activityGlobalIds).toEqual([data.activities.find(a => a.expressId === second)!.globalId]);
  });

  it('validates and round-trips load-case coefficient lists', async () => {
    const scene = await lifecycleScene(pkgs, schema, schema === 'IFC2X3' ? 'load-group' : 'load-case');
    if (schema === 'IFC2X3') {
      expect(() => create.editStructuralEntityInStore(scene.store, scene.editor, scene.id, { SelfWeightCoefficients:[0,0,-1] })).toThrow(/not an editable/);
    } else {
      expect(() => create.editStructuralEntityInStore(scene.store, scene.editor, scene.id, { SelfWeightCoefficients:[0,-1] })).toThrow(/three finite/);
      create.editStructuralEntityInStore(scene.store, scene.editor, scene.id, { SelfWeightCoefficients:[0.1,0.2,-0.9] });
      expect(parser.extractStructuralOnDemand(await parse(scene.exportText())).loadGroups[0].selfWeightCoefficients).toEqual([0.1,0.2,-0.9]);
    }
  });

  it('honors the schema inverse when an activity relationship is removed directly', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'point-action');
    const relation = scene.editor.getNewEntities().find(e => e.type === 'IfcRelConnectsStructuralActivity')!.expressId;
    if (schema === 'IFC2X3') {
      const before = scene.view.getMutations().length;
      expect(() => create.removeStructuralEntityInStore(scene.store, scene.editor, relation)).toThrow(/AssignedToStructuralItem/);
      expect(scene.view.getMutations()).toHaveLength(before);
    } else {
      create.removeStructuralEntityInStore(scene.store, scene.editor, relation);
      expect(parser.extractStructuralOnDemand(await parse(scene.exportText())).activities[0].appliesToGlobalId).toBeUndefined();
    }
  });

  it('refuses deleting the last member link of a surviving connection', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'point-connection');
    const member = scene.editor.getNewEntities().find(e => e.type === 'IfcStructuralCurveMember')!.expressId;
    const before = scene.view.getMutations().length;
    expect(() => create.removeStructuralEntityInStore(scene.store, scene.editor, member)).toThrow(/IfcStructuralPointConnection.*ConnectsStructuralMembers/);
    expect(scene.view.getMutations()).toHaveLength(before);
  });

  it('refuses a load group referenced by a result group without writing', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'result-group');
    const group = scene.editor.getNewEntity(scene.id)!;
    const loadGroup = Number(String(group.attributes[6]).slice(1));
    const before = scene.view.getMutations().length;
    expect(() => create.removeStructuralEntityInStore(scene.store, scene.editor, loadGroup)).toThrow(/IfcStructuralResultGroup.*ResultForLoadGroup/);
    expect(scene.view.getMutations()).toHaveLength(before);
  });

  it('validates enums and stiffness and exports the schema-correct stiffness branch', async () => {
    const scene = await lifecycleScene(pkgs, schema, 'point-connection');
    const condition = Number(String(scene.editor.getNewEntity(scene.id)!.attributes[7]).slice(1));
    const key = schema === 'IFC2X3' ? 'LinearStiffnessX' : 'TranslationalStiffnessX';
    create.editStructuralEntityInStore(scene.store, scene.editor, condition, { [key]: 12.5 });
    const data = parser.extractStructuralOnDemand(await parse(scene.exportText()));
    expect(data.connections[0].appliedCondition?.components[key]).toBe(12.5);
    const before = scene.view.getMutations().length;
    expect(() => create.editStructuralEntityInStore(scene.store, scene.editor, condition, { [key]: Infinity })).toThrow(/stiffness/);
    expect(scene.view.getMutations()).toHaveLength(before);
    const member = create.addStructuralCurveMemberToStore(scene.editor, scene.anchor, { Start:[0,0,0], End:[1,0,0] });
    expect(() => create.editStructuralEntityInStore(scene.store, scene.editor, member.memberId, { PredefinedType: 'INVALID' })).toThrow(/invalid/);
  });
});
