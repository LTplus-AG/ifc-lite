/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStore } from '../lib/packages.mjs';
import { readStep } from '../lib/step.mjs';
import { blankModel, stepsFor } from './create-scene.mjs';

/** Isolated builder occurrence with valid prerequisites. The count snapshot
 * excludes prerequisites but includes every resource the occurrence authors. */
export async function lifecycleScene(pkgs, schema, stepId) {
  const store = await parseStore(pkgs, blankModel(schema));
  const view = new pkgs.mutations.MutablePropertyView(null, 'lifecycle');
  const editor = new pkgs.mutations.StoreEditor(store, view);
  const anchor = pkgs.create.resolveSpatialAnchor(store, 45, view);
  const done = new Map();
  const steps = stepsFor(schema);
  const helper = () => {
    if (!done.has('$helper')) done.set('$helper', pkgs.create.addStructuralCurveMemberToStore(editor, anchor, { Start: [0,0,0], End: [2,0,0] }).memberId);
    return done.get('$helper');
  };
  const needsGroup = step => schema === 'IFC2X3' && Object.keys(step.emits).some(t => ['IfcStructuralLoadGroup', 'IfcStructuralAnalysisModel'].includes(t));
  const groupActivity = () => {
    if (!done.has('$activity')) {
      const activity = pkgs.create.addStructuralPointActionToStore(editor, anchor, { ForceZ: -1 }).activityId;
      pkgs.create.connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, helper(), activity);
      done.set('$activity', activity);
    }
    return done.get('$activity');
  };
  const needsHelper = step => needsGroup(step) || Object.keys(step.emits).some(t => /Connection$|Action$|Reaction$/.test(t));
  const build = step => {
    if (done.has(step.id)) return done.get(step.id);
    for (const need of step.needs ?? []) build(steps.find(s => s.id === need));
    if (needsHelper(step)) helper();
    if (needsGroup(step)) groupActivity();
    const id = step.build({ create: pkgs.create, editor, anchor, done });
    done.set(step.id, id);
    if (needsGroup(step)) pkgs.create.assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, id, [step.emits.IfcStructuralAnalysisModel ? helper() : groupActivity()]);
    const type = editor.getEntityType(id);
    if (/^IfcStructural.*Connection$/.test(type)) pkgs.create.connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, helper(), id);
    if (/^IfcStructural.*(Action|Reaction)$/.test(type)) pkgs.create.connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, helper(), id);
    return id;
  };
  const step = steps.find(s => s.id === stepId);
  for (const need of step.needs ?? []) build(steps.find(s => s.id === need));
  if (needsHelper(step)) helper();
  if (needsGroup(step)) groupActivity();
  const exportText = () => new TextDecoder().decode(new pkgs.exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  if (step.id === 'action-to-connection') {
    const activity = done.get('point-action');
    for (const entity of editor.getNewEntities()) {
      if (entity.type === 'IfcRelConnectsStructuralActivity' && entity.attributes[5] === `#${activity}`) editor.removeEntity(entity.expressId);
    }
  }
  const before = readStep(exportText());
  const id = build(step);
  return { store, view, editor, anchor, id, step, before, exportText };
}

/** A second schema-valid owner shares the first occurrence's resources. Remove
 * the first from re-parsed source, then prove all shared resources survived. */
export async function sharedRemoval(pkgs, schema, stepId) {
  const scene = await lifecycleScene(pkgs, schema, stepId);
  const original = scene.editor.getNewEntity(scene.id);
  if (original.type.startsWith('IfcRel')) return null; // these builders own endpoints only by reference
  const resources = scene.editor.getNewEntities().filter(e => e.expressId !== scene.id
    && !scene.before.entities.has(e.expressId) && !e.type.startsWith('IfcRel')).map(e => e.expressId);
  const attrs = [...original.attributes];
  attrs[0] = '0SharedStructural'.padEnd(22, '0');
  const second = scene.editor.addEntity(original.type, attrs).expressId;
  // Preserve required inverse assignments without duplicating an activity's
  // SET [0:1] link or IFC2X3's scalar group assignment.
  for (const entity of scene.editor.getNewEntities()) {
    const activity = entity.type === 'IfcRelConnectsStructuralActivity' && entity.attributes[5] === `#${scene.id}`;
    const member = entity.type === 'IfcRelConnectsStructuralMember' && entity.attributes[5] === `#${scene.id}`;
    const group = entity.type === 'IfcRelAssignsToGroup' && entity.attributes[6] === `#${scene.id}`;
    if (!activity && !member && !group) continue;
    const args = [...entity.attributes];
    args[0] = `0SharedRel${entity.expressId}`.padEnd(22, '0').slice(0, 22);
    args[group ? 6 : 5] = `#${second}`;
    scene.editor.addEntity(entity.type, args);
  }
  const created = scene.exportText();
  // IFC2X3 LocalPlacement is single-owner; the exporter correctly duplicates
  // it. Assert survival for resources actually shared by the exported owners.
  const exported = readStep(created);
  const referenced = value => Array.isArray(value) ? value.flatMap(referenced)
    : value && typeof value === 'object' && 'ref' in value ? [value.ref] : [];
  const reachable = new Set([second]);
  const pending = [second];
  while (pending.length) {
    for (const id of referenced(exported.entities.get(pending.pop())?.args ?? [])) {
      if (!reachable.has(id)) { reachable.add(id); pending.push(id); }
    }
  }
  const sharedResources = resources.filter(id => reachable.has(id));
  if (resources.length && !sharedResources.length) throw new Error('sharing scenario has no shared resource');
  const store = await parseStore(pkgs, created);
  const view = new pkgs.mutations.MutablePropertyView(null, 'shared-source');
  const editor = new pkgs.mutations.StoreEditor(store, view);
  pkgs.create.removeStructuralEntityInStore(store, editor, scene.id);
  const text = new TextDecoder().decode(new pkgs.exporter.StepExporter(store, view).export({ schema, applyMutations: true }).content);
  saveProof(created, schema, stepId, 'shared-created');
  saveProof(text, schema, stepId, 'shared-removed');
  const after = readStep(text);
  if (after.entities.has(scene.id) || !after.entities.has(second) || sharedResources.some(id => !after.entities.has(id))) {
    throw new Error(`shared removal: original present=${after.entities.has(scene.id)}, second present=${after.entities.has(second)}, missing resources=${sharedResources.filter(id => !after.entities.has(id)).join(',')}`);
  }
  return { created, text };
}

/** Optional external-oracle artifacts; scoring never relies on this output. */
export function saveProof(text, schema, step, stage) {
  if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(join(process.env.STRUCTURAL_EXPORT_DIR, `${schema}-${step}-${stage}.ifc`), text);
}
