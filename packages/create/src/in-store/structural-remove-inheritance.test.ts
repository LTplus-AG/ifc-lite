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
type Link = 'plain' | 'eccentric';
type Storage = 'source' | 'overlay';
const ref = (value: unknown) => Number(String(value).slice(1));
const parse = (text: string) => new parser.IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
function save(text: string, name: string) {
  if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(join(process.env.STRUCTURAL_EXPORT_DIR, `${name}.ifc`), text);
}

async function importedLinks(schema: Schema, storage: Storage, first: Link, second?: Link) {
  const scene = await lifecycleScene(pkgs, schema, 'point-connection');
  const connection = scene.editor.getNewEntity(scene.id)!;
  const placement = scene.editor.getNewEntity(ref(connection.attributes[5]))!;
  const axis = scene.editor.getNewEntity(ref(placement.attributes[1]))!;
  const pointId = ref(axis.attributes[0]);
  const original = scene.editor.getNewEntities().find(e => e.type === 'IfcRelConnectsStructuralMember')!;
  const memberId = ref(original.attributes[4]);
  const constraints = new Map<number, number>();
  const eccentric = (id: number) => {
    const constraint = scene.editor.addEntity('IfcConnectionPointEccentricity', [`#${pointId}`, null, 0.1, 0, 0]).expressId;
    scene.editor.setEntityType(id, 'IfcRelConnectsWithEccentricity');
    scene.editor.setPositionalAttribute(id, 10, `#${constraint}`);
    constraints.set(id, constraint);
  };
  if (first === 'eccentric') eccentric(original.expressId);
  let survivor: { memberId: number; relationId: number } | undefined;
  if (second) {
    const member = create.addStructuralCurveMemberToStore(scene.editor, scene.anchor, { Start: [0,0,0], End: [0,0,3] });
    const relationId = create.connectStructuralMemberToConnectionInStore(scene.editor, scene.anchor.ownerHistoryId, member.memberId, scene.id);
    if (second === 'eccentric') eccentric(relationId);
    survivor = { memberId: member.memberId, relationId };
  }
  const created = scene.exportText();
  const baseline = await parse(created);
  const store = storage === 'source' ? baseline : scene.store;
  const view = storage === 'source' ? new mutations.MutablePropertyView(null, 'imported-inheritance') : scene.view;
  const editor = storage === 'source' ? new mutations.StoreEditor(store, view) : scene.editor;
  const exportText = () => new TextDecoder().decode(new exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  return { created, baseline, store, view, editor, exportText, connectionId: scene.id, memberId, relationId: original.expressId, constraints, survivor };
}

// #9668 / #9819: EXPRESS inverse bounds include relationship subtypes.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s imported structural relationship inheritance', schema => {
  describe.each(['source', 'overlay'] as const)('%s records', storage => {
    for (const first of ['plain', 'eccentric'] as const) {
      it.each(['member', 'relationship'] as const)(`refuses removing the only ${first} %s link without writing`, async target => {
        const scene = await importedLinks(schema, storage, first);
        const journalSize = scene.view.getMutationCount();
        const id = target === 'member' ? scene.memberId : scene.relationId;
        expect(() => create.removeStructuralEntityInStore(scene.store, scene.editor, id))
          .toThrow(`IfcStructuralPointConnection #${scene.connectionId}.ConnectsStructuralMembers`);
        expect(scene.view.getMutationCount()).toBe(journalSize);
        expect(scene.editor.hasEntity(scene.memberId)).toBe(true);
        expect(scene.editor.hasEntity(scene.relationId)).toBe(true);
        const text = scene.exportText();
        const after = await parse(text);
        expect(new Set(after.entityIndex.byId.keys())).toEqual(new Set(scene.baseline.entityIndex.byId.keys()));
        if (storage === 'source') {
          save(scene.created, `${schema}-eccentric-only-${first}-${target}-created`);
          save(text, `${schema}-eccentric-only-${first}-${target}-refused`);
        }
      });
    }

    for (const target of ['member', 'relationship'] as const) {
      it.each(['plain', 'eccentric'] as const)(`removes a %s ${target} link when the other subtype survives`, async first => {
        const scene = await importedLinks(schema, storage, first, first === 'plain' ? 'eccentric' : 'plain');
        const survivor = scene.survivor!;
        create.removeStructuralEntityInStore(scene.store, scene.editor, target === 'member' ? scene.memberId : scene.relationId);
        const text = scene.exportText();
        const after = await parse(text);
        expect(after.entityIndex.byId.has(scene.relationId)).toBe(false);
        expect(after.entityIndex.byId.has(scene.memberId)).toBe(target === 'relationship');
        expect(after.entityIndex.byId.has(survivor.relationId)).toBe(true);
        expect(after.entityIndex.byId.has(survivor.memberId)).toBe(true);
        for (const [relation, constraint] of scene.constraints) {
          expect(after.entityIndex.byId.has(constraint)).toBe(relation === survivor.relationId);
        }
        const data = parser.extractStructuralOnDemand(after);
        const keptMember = data.members.find(m => m.expressId === survivor.memberId)!;
        expect(data.connections.find(c => c.expressId === scene.connectionId)?.memberGlobalIds).toEqual([keptMember.globalId]);
        if (storage === 'source') {
          save(scene.created, `${schema}-eccentric-mixed-${first}-${target}-created`);
          save(text, `${schema}-eccentric-mixed-${first}-${target}-removed`);
        }
      });
    }
  });
});
