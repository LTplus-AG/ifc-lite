/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { parseStore } from '../lib/packages.mjs';
import { readStep } from '../lib/step.mjs';
import { stepsFor } from './create-scene.mjs';
import { lifecycleScene, saveProof } from './lifecycle-scene.mjs';

function findRecord(value, id) {
  if (!value || typeof value !== 'object') return null;
  if (value.expressId === id) return value;
  for (const child of Object.values(value)) {
    const found = findRecord(child, id);
    if (found) return found;
  }
  return null;
}

export default {
  name: 'edit:in-store-update', level: 'edit',
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const steps = stepsFor(row.schema).filter(s => s.emits[row.entity]);
      if (!steps.length) { out.set(row.id, { status: 'fail', reason: 'no create builder for this entity' }); continue; }
      try {
        for (const step of steps) {
          const scene = await lifecycleScene(ctx.pkgs, row.schema, step.id);
          const before = readStep(scene.exportText());
          const rec = before.of(row.entity).find(r => !scene.before.entities.has(r.id));
          if (!rec) throw new Error('builder did not emit the entity');
          const memberRelation = row.entity === 'IfcRelConnectsStructuralMember';
          const activityRelation = row.entity === 'IfcRelConnectsStructuralActivity';
          let destination;
          if (activityRelation) destination = ctx.pkgs.create.addStructuralCurveMemberToStore(scene.editor, scene.anchor, { Start:[0,0,0], End:[3,0,0] }).memberId;
          const intact = readStep(scene.exportText());
          const patch = activityRelation ? { RelatingElement: destination } : memberRelation ? { SupportedLength: 0.25 } : { Name: 'Edited structural value' };
          ctx.pkgs.create.editStructuralEntityInStore(scene.store, scene.editor, rec.id, patch);
          const text = scene.exportText();
          saveProof(text, row.schema, step.id, `edited-${row.entity}`);
          const parsed = await parseStore(ctx.pkgs, text);
          const extracted = ctx.pkgs.parser.extractStructuralOnDemand(parsed);
          const result = activityRelation ? extracted.activities.find(a => a.expressId === rec.args[5].ref) : findRecord(extracted, rec.id);
          const destinationGlobalId = destination ? intact.entities.get(destination).args[0] : undefined;
          if (!result || (activityRelation ? result.appliesToGlobalId !== destinationGlobalId : memberRelation ? result.SupportedLength !== 0.25 : result.name !== patch.Name)) {
            throw new Error('new value not returned by the structural extractor');
          }
          const after = readStep(text);
          if (after.entities.size !== intact.entities.size || [...intact.entities.keys()].some(id => !after.entities.has(id))) {
            throw new Error('edit changed the owned subgraph');
          }
        }
        out.set(row.id, { status: 'pass', evidence: steps.map(s => s.builder) });
      } catch (e) { out.set(row.id, { status: 'fail', reason: e.message }); }
    }
    return out;
  },
};
