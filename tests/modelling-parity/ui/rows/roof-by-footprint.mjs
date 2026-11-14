/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { roofGeometry } from '../lib/oracles.mjs';
import { task } from '../lib/driver.mjs';
import { escape, oracleModel, tool, typeFields } from '../lib/model-ui.mjs';

import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { setupRoom } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.roof',
    capability: 'roof-by-footprint',
    title: 'Roof over a 5x4 m footprint (hip expected; #9214)',
    async run(s) {
      const tasks = [await setupRoom(s)];
      const notes = ['The exported roof is meshed and checked against four 30-degree eave planes; its IFC type alone cannot establish a hip.'];
      tasks.push(await task(s, 'Roof tool, typed 5.6 x 4.6 m', async () => {
        await s.ui.key('Shift+Y', { settle: 300 });
        await s.ui.clickWorld([-0.3, -0.3, 3], { modifiers: ['Alt'] });
        await typeFields(s, [5.6, 4.6]);
        await escape(s);
      }));
      await s.harness.aim([14, -12, 12], [2.5, 2, 1.5], { pin: false });
      const shot = await s.shot('roof');
      const { step, text } = await oracleModel(s);
      const roofs = [...step.of('IFCROOF'), ...step.of('IFCSLAB').filter((x) => x.args?.[8]?.enum === 'ROOF')];
      // Reuse the geometric SDK oracle: slabs, full-height prisms and mono-pitch
      // plates cannot pass as a hip even if their IFC label says HIP_ROOF.
      const sloped = roofGeometry(step, await meshIfc(text), {
        footprint: [[-.3,-.3],[5.3,-.3],[5.3,4.3],[-.3,4.3]],
        slopes: Array(4).fill(Math.PI / 6), thickness: .3, hip: true,
      });
      return {
        tasks, notes, evidence: [shot],
        metrics: { roofBaseZ: roofs[0] ? step.placement(roofs[0].id).origin[2] : null, clickedZ: 3 },
        checks: [
          { name: 'a roof element exists (IfcRoof or IfcSlab ROOF)', ok: roofs.length >= 1, detail: `${roofs.length} roof elements` },
          { name: 'the roof is sloped (hip by footprint)', ok: sloped === true, detail: sloped === true ? 'four 30-degree planes, low eaves, high centre and volume pass the native-mesh oracle' : sloped },
        ],
      };
    },
  };
