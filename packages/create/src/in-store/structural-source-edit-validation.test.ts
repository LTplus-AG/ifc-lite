/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as create from '../index.js';
import * as parser from '@ifc-lite/parser';
import * as mutations from '@ifc-lite/mutations';
import * as exporter from '@ifc-lite/export';
import { lifecycleScene } from '../../../../tests/structural-coverage/probes/lifecycle-scene.mjs';

const pkgs = { create, parser, mutations, exporter };
type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';
const parse = (text: string) => new parser.IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
const save = (text: string, name: string) => {
  if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(join(process.env.STRUCTURAL_EXPORT_DIR, `${name}.ifc`), text);
};
async function editScene(schema: Schema, storage: 'source' | 'overlay', step: string) {
  const scene = await lifecycleScene(pkgs, schema, step);
  const created = scene.exportText();
  const store = storage === 'source' ? await parse(created) : scene.store;
  const view = storage === 'source' ? new mutations.MutablePropertyView(null, 'load-source') : scene.view;
  const editor = storage === 'source' ? new mutations.StoreEditor(store, view) : scene.editor;
  const exportText = () => new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  return { id: scene.id, created, store, view, editor, exportText };
}

// #9668 / #9819: uppercase source types must receive the same validation as overlay records.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s load component validation', schema => {
  it.each(['source', 'overlay'] as const)('refuses an empty load and permits atomic replacement (%s)', async storage => {
    const scene = await editScene(schema, storage, 'point-action');
    const initial = parser.extractStructuralOnDemand(await parse(scene.created));
    const loadId = initial.activities[0].appliedLoad!.expressId;
    const empty = { ForceX: null, ForceY: null, ForceZ: null, MomentX: null, MomentY: null, MomentZ: null };
    const journalSize = scene.view.getMutationCount();
    expect(() => create.editStructuralEntityInStore(scene.store, scene.editor, loadId, empty)).toThrow(/at least one load component/);
    expect(scene.view.getMutationCount()).toBe(journalSize);
    const refused = scene.exportText();
    expect(parser.extractStructuralOnDemand(await parse(refused)).activities[0].appliedLoad?.components.ForceZ).toBe(-10);
    create.editStructuralEntityInStore(scene.store, scene.editor, loadId, { ...empty, ForceZ: -7 });
    const edited = scene.exportText();
    expect(parser.extractStructuralOnDemand(await parse(edited)).activities[0].appliedLoad?.components).toEqual({ ForceZ: -7 });
    if (storage === 'source') {
      save(scene.created, `${schema}-load-validation-created`);
      save(refused, `${schema}-load-validation-refused`);
      save(edited, `${schema}-load-validation-edited`);
    }
  });
});

describe.each(['IFC4', 'IFC4X3'] as const)('%s load-case predefined type validation', schema => {
  it.each(['source', 'overlay'] as const)('refuses NOTDEFINED without writing and permits a valid edit (%s)', async storage => {
    const scene = await editScene(schema, storage, 'load-case');
    const journalSize = scene.view.getMutationCount();
    expect(() => create.editStructuralEntityInStore(scene.store, scene.editor, scene.id,
      { Name: 'Must not be written', PredefinedType: 'NOTDEFINED' })).toThrow(/requires LOAD_CASE/);
    expect(scene.view.getMutationCount()).toBe(journalSize);
    const refused = scene.exportText();
    const groups = parser.extractStructuralOnDemand(await parse(refused)).loadGroups;
    expect(groups.find(g => g.expressId === scene.id)?.predefinedType).toBe('LOAD_CASE');
    expect(groups.find(g => g.expressId === scene.id)?.name).not.toBe('Must not be written');
    create.editStructuralEntityInStore(scene.store, scene.editor, scene.id,
      { Name: 'Validated case', SelfWeightCoefficients: [0.2, 0.3, -0.7] });
    const edited = scene.exportText();
    expect(parser.extractStructuralOnDemand(await parse(edited)).loadGroups.find(g => g.expressId === scene.id))
      .toMatchObject({ name: 'Validated case', predefinedType: 'LOAD_CASE', selfWeightCoefficients: [0.2, 0.3, -0.7] });
    if (storage === 'source') {
      save(scene.created, `${schema}-case-validation-created`);
      save(refused, `${schema}-case-validation-refused`);
      save(edited, `${schema}-case-validation-edited`);
    }
  });
});

// #9668: the eccentricity of a member-connection relationship is a structural resource.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s connection eccentricity edit', schema => {
  it.each(['source', 'overlay'] as const)('edits EccentricityInX and the extractor returns it (%s)', async storage => {
    const eccentricityOf = async (text: string) => parser.extractStructuralOnDemand(await parse(text)).members
      .flatMap(m => m.IfcRelConnectsStructuralMember ?? []).find(r => r.ConnectionConstraint)?.ConnectionConstraint;
    const scene = await editScene(schema, storage, 'IfcFailureConnectionCondition');
    const initial = await eccentricityOf(scene.created);
    expect(initial).toBeDefined();
    const expressId = initial!.expressId;
    create.editStructuralEntityInStore(scene.store, scene.editor, expressId, { EccentricityInX: 0.15 });
    const edited = scene.exportText();
    expect(await eccentricityOf(edited)).toMatchObject({ expressId, EccentricityInX: 0.15, EccentricityInY: 0.2 });
    // Its relationship requires it, so removal goes through that relationship.
    expect(() => create.removeStructuralEntityInStore(scene.store, scene.editor, expressId)).toThrow(/remove the relationship that owns it/);
    expect(scene.exportText()).toBe(edited);
  });
});
