/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { copyLevelElevations } from '../lib/measured-oracles.mjs';
import { copiedPlansMatch } from '../lib/oracles.mjs';
import { task } from '../lib/driver.mjs';
import { oracleModel, openStoreyManager, switchStorey, toasts } from '../lib/model-ui.mjs';


import { PLAN_CAM, near, fmt, setupRoom, selectAt, wallsOn } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.copy-to-levels',
    capability: 'copy-to-levels',
    title: 'Copy four walls to two storeys above with Ctrl+C, storey switch, Ctrl+Shift+V',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'setup: add two storeys above', async () => {
        await openStoreyManager(s);
        const add = s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first();
        await s.ui.click(add, { settle: 600 });
        await s.ui.click(add, { settle: 600 });
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
      }).then(t => Object.assign(t, { setup: true })));
      await s.harness.aim(PLAN_CAM.pos, PLAN_CAM.target);
      let selected = 0;
      tasks.push(await task(s, 'select the 4 walls (click, Ctrl+click) and copy', async () => {
        selected = await selectAt(s, [[2.5, 0, 1.5], [5, 2, 1.5], [2.5, 4, 1.5], [0, 2, 1.5]]);
        await s.ui.key('Control+C');
      }));
      const copied = await toasts(s);
      for (const level of ['Level 2', 'Level 3']) {
        tasks.push(await task(s, `switch to ${level} and paste in place`, async () => {
          await switchStorey(s, level);
          await s.ui.key('Control+Shift+V', { settle: 800 });
        }));
      }
      const notes = ['Copying to several storeys is one storey at a time: switch storey, paste, repeat.'];
      const shot = await s.shot('copied');
      const { step } = await oracleModel(s);
      const l1 = wallsOn(step, 'Level 1');
      const l2 = wallsOn(step, 'Level 2');
      const l3 = wallsOn(step, 'Level 3');
      const storeys = step.storeys();
      const z2 = storeys.find((x) => x.name === 'Level 2')?.elevation;
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: '4 walls selected by click and Ctrl+click', ok: selected === 4, detail: `${selected} selected; ${copied.join(' / ')}` },
          { name: '4 walls on Level 2', ok: l2.length === 4, detail: `${l2.length}` },
          { name: '4 walls on Level 3', ok: l3.length === 4, detail: `${l3.length}` },
          { name: 'copies keep the plan position of the Level 1 walls', ok: l1.length === 4 && copiedPlansMatch(l1, [l2,l3]) && copyLevelElevations([z2,storeys.find(st=>st.name==='Level 3')?.elevation],[l2,l3]), detail: [l2,l3].map((walls) => walls.map((w) => fmt(w.start)).join(' ') || 'none').join(' / ') },
          { name: 'Level 2 at +3.0 m', ok: near(z2 ?? -1, 3, 1e-6), detail: `${z2}` },
        ],
      };
    },
  };
