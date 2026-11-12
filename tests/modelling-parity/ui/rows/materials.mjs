/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assignedLayerMaterials } from '../lib/measured-oracles.mjs';
import { task } from '../lib/driver.mjs';
import { oracleModel } from '../lib/model-ui.mjs';
import { check, wall, layer, applyLayers, finish } from '../lib/authoring-helpers.mjs';

export default {
    id:'ui.materials', capability:'materials', title:'Create and assign a material through wall layers',
    async run(s) {
      const tasks = [await task(s,'create Brick material and draw layered wall',async () => {
        await layer(s,1,.2,'Brick');
        await applyLayers(s);
        await wall(s);
      })];
      const { step } = await oracleModel(s);
      const walls = step.of('IFCWALL');
      const assigned = walls.map(w => assignedLayerMaterials(step,w.id));
      return finish(s,tasks,[
        check('named material assigned through exported layers',walls.length === 1 && assigned.every(names => names.length === 1 && names[0] === 'Brick'), JSON.stringify(assigned)),
        check('material appearance colour and reassignment',false,'layer editor creates names; material colour editing, reassignment and rendered colour are not measured'),
      ]);
    },
  };
