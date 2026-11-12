/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
      const names = step.of('IFCMATERIAL').map((m) => m.args[0]);
      return finish(s,tasks,[
        check('named material assigned through exported layers',names.includes('Brick') && step.count('IFCRELASSOCIATESMATERIAL') > 0 && step.count('IFCMATERIALLAYERSETUSAGE') > 0, JSON.stringify(names)),
        check('material appearance colour and reassignment',false,'layer editor creates names; material colour editing, reassignment and rendered colour are not measured'),
      ]);
    },
  };
