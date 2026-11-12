/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readStep } from '../lib/step.mjs';
import { parseStore } from '../lib/packages.mjs';
import { stepsFor } from './create-scene.mjs';
import { lifecycleScene, sharedRemoval, saveProof } from './lifecycle-scene.mjs';

function dangling(file) {
  const visit = value => Array.isArray(value) ? value.flatMap(visit)
    : value && typeof value === 'object' && 'ref' in value && !file.entities.has(value.ref) ? [value.ref] : [];
  return [...file.entities.values()].flatMap(r => visit(r.args));
}

export default {
  name: 'remove:in-store-owned-subgraph', level: 'remove',
  async run(rows, ctx) {
    const out = new Map();
    for (const row of rows) {
      const steps = stepsFor(row.schema).filter(s => s.emits[row.entity]);
      if (!steps.length) { out.set(row.id, { status: 'fail', reason: 'no create builder for this entity' }); continue; }
      try {
        for (const step of steps) {
          // IFC2X3's activity assignment is required and single-valued. Its
          // valid removal path is cleanup with the activity, like an owned
          // load. Standalone relationship removal is separately tested to refuse.
          const sceneStep = row.schema === 'IFC2X3' && row.entity === 'IfcRelConnectsStructuralActivity'
            ? 'point-action' : step.id;
          const scene = await lifecycleScene(ctx.pkgs, row.schema, sceneStep);
          const createdText = scene.exportText();
          saveProof(createdText, row.schema, step.id, 'created');
          const created = readStep(createdText);
          const ids = created.of(row.entity).filter(r => !scene.before.entities.has(r.id)).map(r => r.id);
          if (!ids.length) throw new Error('builder did not emit the entity');
          // Auxiliary loads and conditions leave with their owner, rather than
          // invalidating an activity's required AppliedLoad reference.
          ctx.pkgs.create.removeStructuralEntityInStore(scene.store, scene.editor, scene.id);
          const text = scene.exportText();
          await parseStore(ctx.pkgs, text);
          const after = readStep(text);
          if (ids.some(id => after.entities.has(id))) throw new Error('entity survived removal');
          if (after.entities.size !== scene.before.entities.size) throw new Error(`entity count ${after.entities.size}, expected ${scene.before.entities.size}`);
          if (dangling(after).length) throw new Error('export contains dangling references');
          saveProof(text, row.schema, step.id, 'removed');
          const shared = await sharedRemoval(ctx.pkgs, row.schema, sceneStep);
          if (shared) {
            saveProof(shared.created, row.schema, step.id, 'shared-created');
            saveProof(shared.text, row.schema, step.id, 'shared-removed');
          }
          if (shared && dangling(readStep(shared.text)).length) throw new Error('shared export contains dangling references');
        }
        out.set(row.id, { status: 'pass', evidence: steps.map(s => s.builder) });
      } catch (e) { out.set(row.id, { status: 'fail', reason: e.message }); }
    }
    return out;
  },
};
