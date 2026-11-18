/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { task } from '../lib/driver.mjs';
import { escape, oracleModel, tool } from '../lib/model-ui.mjs';




export default {
    id: 'ui.curtain-wall',
    capability: 'curtain-walls',
    title: 'Curtain wall by two clicks',
    async run(s) {
      const tasks = [];
      tasks.push(await task(s, 'curtain wall: Shift+U, click two points', async () => {
        await escape(s);
        await tool(s, 'curtainwall.place');
        await s.ui.clickWorld([0, 0, 0]);
        await s.ui.clickWorld([6, 0, 0]);
        await escape(s);
      }));
      const shot = await s.shot('curtain');
      const { step } = await oracleModel(s);
      const c = step.counts(['IFCCURTAINWALL', 'IFCPLATE', 'IFCMEMBER', 'IFCRELAGGREGATES']);
      const cw = step.of('IFCCURTAINWALL')[0];
      const parts = cw ? step.of('IFCRELAGGREGATES').filter((r) => r.args?.[4]?.ref === cw.id).flatMap((r) => r.args[5]).map((r) => step.get(r)?.type) : [];
      return {
        tasks, notes: [], evidence: [shot],
        checks: [
          { name: 'IfcCurtainWall', ok: c.IFCCURTAINWALL === 1, detail: JSON.stringify(c) },
          { name: 'decomposed into plates and members', ok: parts.includes('IFCPLATE') && parts.includes('IFCMEMBER'), detail: `${parts.length} parts` },
        ],
      };
    },
  };
