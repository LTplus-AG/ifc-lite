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

const EDIT_NAME = () => ({
  patch: { Name: 'Edited structural value' },
  returned: (extracted, rec) => findRecord(extracted, rec.id)?.name === 'Edited structural value',
});

/** Rows whose read record has no Name: relationship records, and the
 * eccentricity, which has no Name attribute. Each edits what it exposes. */
const EDITS = {
  IfcRelConnectsStructuralMember: () => ({
    patch: { SupportedLength: 0.25 },
    returned: (extracted, rec) => findRecord(extracted, rec.id)?.SupportedLength === 0.25,
  }),
  IfcConnectionGeometry: () => ({
    patch: { EccentricityInX: 0.15 },
    returned: (extracted, rec) => findRecord(extracted, rec.id)?.EccentricityInX === 0.15,
  }),
  IfcRelConnectsStructuralActivity: (create, scene) => {
    const member = create.addStructuralCurveMemberToStore(scene.editor, scene.anchor, { Start:[0,0,0], End:[3,0,0] }).memberId;
    return {
      patch: { RelatingElement: member },
      returned: (extracted, rec, intact) => extracted.activities.find(a => a.expressId === rec.args[5].ref)?.appliesToGlobalId === intact.entities.get(member).args[0],
    };
  },
  IfcRelConnectsStructuralElement: (create, scene) => {
    const beam = create.addBeamToStore(scene.editor, scene.anchor, { Start:[0,0,0], End:[3,0,0], Width:0.2, Height:0.3 }).beamId;
    return {
      patch: { RelatingElement: beam },
      returned: (extracted, rec) => String(extracted.members.find(m => m.expressId === rec.args[5].ref)?.physicalElementIds) === String([beam]),
    };
  },
};

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
          const edit = (EDITS[row.root] ?? EDIT_NAME)(ctx.pkgs.create, scene);
          const intact = readStep(scene.exportText());
          ctx.pkgs.create.editStructuralEntityInStore(scene.store, scene.editor, rec.id, edit.patch);
          const text = scene.exportText();
          saveProof(text, row.schema, step.id, `edited-${row.entity}`);
          const parsed = await parseStore(ctx.pkgs, text);
          const extracted = ctx.pkgs.parser.extractStructuralOnDemand(parsed);
          if (!edit.returned(extracted, rec, intact)) throw new Error('new value not returned by the structural extractor');
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
