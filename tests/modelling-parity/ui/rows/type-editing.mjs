/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addTypeFireRating } from '../lib/property-ui.mjs';
import { inheritedFireRating, typeOf } from '../lib/measured-oracles.mjs';
import { task } from '../lib/driver.mjs';
import { oracleModel } from '../lib/model-ui.mjs';
import { check, field, wall, selectWall, typeScope, newType, layer, applyLayers, wallSize, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id: 'ui.type-editing', capability: 'type-editing',
    title: 'Place two walls of one type, edit its layer thickness',
    async run(s) {
      const tasks = [await task(s, 'create WT-200 and place two instances', async () => {
        await newType(s,'WT-200');
        await wall(s);
        await wall(s,3);
        await selectWall(s);
      })];
      tasks.push(await task(s,'apply 300 mm layers to Type',async () => {
        await field(s,s.page.getByLabel('Layer 1 thickness in metres'),.3);
        await typeScope(s);
        await applyLayers(s);
      }));
      const { step } = await oracleModel(s);
      const sizes = step.of('IFCWALL').map((e) => wallSize(step,e));
      const typed = new Set(step.of('IFCRELDEFINESBYTYPE').flatMap((r) => (r.args[4] ?? []).map((v) => v.ref)));
      tasks.push(await task(s, 'edit inherited FireRating with Apply To Type', async () => {
        await selectWall(s);
        await s.ui.click(s.page.locator('[data-model-inspector]').getByRole('button', { name: 'Properties', exact: true }));
        await addTypeFireRating(s,'WT-200');
        await selectWall(s);
        await s.ui.click(s.page.locator('[data-model-inspector]').getByRole('button', { name: 'Properties', exact: true }));
        const rating = s.page.getByRole('button', { name: /^FireRating:/ });
        if (!(await rating.count())) {
          const set = s.page.getByRole('button',{name:/Pset_WallCommon/}).last();
          if (!(await set.count())) throw new Error('The type exports FireRating through HasPropertySets, but Properties does not show that inherited set on its wall occurrence.');
          await s.ui.click(set);
        }
        if (!(await rating.count())) throw new Error('Authored type has no inherited FireRating in Properties; this UI workflow cannot exercise the type-property edit.');
        await s.ui.click(rating);
        await field(s, s.page.getByRole('textbox',{name:'FireRating',exact:true}), 'REI60');
        await s.ui.click(s.page.getByRole('button', { name: 'Apply To Type', exact: true }));
      }));
      const shared = (await oracleModel(s)).step;
      tasks.push(await task(s, 'swap only wall 2 to WT-150', async () => {
        await selectWall(s,3);
        await newType(s,'WT-150');
        await field(s,s.page.getByLabel('Layer 1 thickness in metres'),.15);
        await typeScope(s);
        await applyLayers(s);
      }));
      const swapped = (await oracleModel(s)).step;
      const [w1,w2] = step.of('IFCWALL');
      return finish(s,tasks,[
        check('two typed walls exported', sizes.length === 2 && step.of('IFCWALL').every((w) => typed.has(w.id)), `${sizes.length} walls; ${typed.size} typed occurrences`),
        check('both instances update to 300 mm', sizes.length === 2 && sizes.every((v) => near(v.thickness,.3)), JSON.stringify(sizes)),
        check('FireRating stored once on the shared wall type', inheritedFireRating(shared,shared.of('IFCWALL')), 'Requires one HasPropertySets reference and no occurrence copy'),
        check('only wall 2 swaps type and thickness', !!w1 && !!w2 && typeOf(swapped,w1.id) === typeOf(step,w1.id) && typeOf(swapped,w2.id) !== undefined && swapped.get(typeOf(swapped,w2.id))?.args[2] === 'WT-150' && typeOf(swapped,w2.id) !== typeOf(step,w2.id) && near(wallSize(swapped,swapped.get(w1.id)).thickness,.3) && near(wallSize(swapped,swapped.get(w2.id)).thickness,.15), JSON.stringify(swapped.of('IFCWALL').map(w => ({id:w.id,type:typeOf(swapped,w.id),...wallSize(swapped,w)})))),
      ]);
    },
  };
