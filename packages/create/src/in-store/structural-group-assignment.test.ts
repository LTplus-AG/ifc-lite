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
async function assignmentScene(schema: Schema, storage: 'source' | 'overlay', structural = true) {
  const scene = await lifecycleScene(pkgs, schema, 'curve-member');
  const groupId = structural
    ? create.addStructuralAnalysisModelToStore(scene.editor, scene.anchor, { Name: 'Assignment model', PredefinedType: 'LOADING_3D' }).analysisModelId
    : scene.editor.addEntity('IfcGroup', ['0OrdinaryGroup'.padEnd(22, '0'), `#${scene.anchor.ownerHistoryId}`, 'Ordinary group', null, null]).expressId;
  const relationshipId = create.assignToStructuralGroupInStore(scene.editor, scene.anchor.ownerHistoryId, groupId, [scene.id]);
  const created = scene.exportText();
  const baseline = await parse(created);
  const store = storage === 'source' ? baseline : scene.store;
  const view = storage === 'source' ? new mutations.MutablePropertyView(null, 'assignment-source') : scene.view;
  const editor = storage === 'source' ? new mutations.StoreEditor(store, view) : scene.editor;
  const exportText = () => new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  return { groupId, memberId: scene.id, relationshipId, created, baseline, store, view, editor, exportText };
}

// #9668 / #9819: source STEP names are uppercase; structural assignments still edit and remove.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s structural group assignments', schema => {
  describe.each(['source', 'overlay'] as const)('%s records', storage => {
    it('edits the relationship and preserves the extracted group membership', async () => {
      const scene = await assignmentScene(schema, storage);
      create.editStructuralEntityInStore(scene.store, scene.editor, scene.relationshipId, { Name: 'Edited assignment' });
      const text = scene.exportText();
      const after = await parse(text);
      const relationship = new parser.EntityExtractor(after.source).extractEntity(after.entityIndex.byId.get(scene.relationshipId)!)!;
      expect(relationship.attributes[2]).toBe('Edited assignment');
      const data = parser.extractStructuralOnDemand(after);
      expect(data.members.find(m => m.expressId === scene.memberId)?.analysisModelGlobalIds).toEqual([data.analysisModels[0].globalId]);
      expect(new Set(after.entityIndex.byId.keys())).toEqual(new Set(scene.baseline.entityIndex.byId.keys()));
      if (storage === 'source') {
        save(scene.created, `${schema}-assignment-edit-created`);
        save(text, `${schema}-assignment-edited`);
      }
    });

    it('removes an optional assignment or names the mandatory IFC2X3 membership', async () => {
      const scene = await assignmentScene(schema, storage);
      const journalSize = scene.view.getMutationCount();
      if (schema === 'IFC2X3') {
        expect(() => create.removeStructuralEntityInStore(scene.store, scene.editor, scene.relationshipId))
          .toThrow(`IfcStructuralAnalysisModel #${scene.groupId}.IsGroupedBy`);
        expect(scene.view.getMutationCount()).toBe(journalSize);
      } else {
        create.removeStructuralEntityInStore(scene.store, scene.editor, scene.relationshipId);
      }
      const text = scene.exportText();
      const after = await parse(text);
      expect(after.entityIndex.byId.has(scene.relationshipId)).toBe(schema === 'IFC2X3');
      const expectedIds = new Set(scene.baseline.entityIndex.byId.keys());
      if (schema !== 'IFC2X3') expectedIds.delete(scene.relationshipId);
      expect(new Set(after.entityIndex.byId.keys())).toEqual(expectedIds);
      const data = parser.extractStructuralOnDemand(after);
      expect(data.members.find(m => m.expressId === scene.memberId)?.analysisModelGlobalIds)
        .toEqual(schema === 'IFC2X3' ? [data.analysisModels[0].globalId] : []);
      if (storage === 'source') {
        save(scene.created, `${schema}-assignment-remove-created`);
        save(text, `${schema}-assignment-removed-or-refused`);
      }
    });

    it('refuses a non-structural group assignment without writing', async () => {
      const scene = await assignmentScene(schema, storage, false);
      const journalSize = scene.view.getMutationCount();
      expect(() => create.editStructuralEntityInStore(scene.store, scene.editor, scene.relationshipId, { Name: 'Wrong scope' })).toThrow(/not a live structural entity/);
      expect(() => create.removeStructuralEntityInStore(scene.store, scene.editor, scene.relationshipId)).toThrow(/not a live structural entity/);
      expect(scene.view.getMutationCount()).toBe(journalSize);
      expect(scene.editor.hasEntity(scene.relationshipId)).toBe(true);
    });
  });
});
