/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assignedTypes, ownOpenings } from '../lib/oracles.mjs';
import { task } from '../lib/driver.mjs';
import { escape, oracleModel, tool, toasts } from '../lib/model-ui.mjs';


import { setupRoom } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.hosted-openings',
    capability: 'hosted-doors-windows-from-types',
    title: 'Click a wall with the door and window tools',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'door: Shift+D, click the south wall', async () => {
        await tool(s, 'door.place');
        await s.ui.clickWorld([2.5, 0, 1]);
        await escape(s);
      }));
      tasks.push(await task(s, 'window: Shift+W, click the east wall', async () => {
        await tool(s, 'window.place');
        await s.ui.clickWorld([5, 2, 1.5]);
        await escape(s);
      }));
      const notes = [];
      const t = await toasts(s);
      if (t.length) notes.push(`toasts: ${t.join(' / ')}`);
      const shot = await s.shot('hosted');
      const { step } = await oracleModel(s);
      const c = step.counts(['IFCDOOR', 'IFCWINDOW', 'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCDOORTYPE', 'IFCWINDOWTYPE', 'IFCRELDEFINESBYTYPE']);
      const wallIds = new Set(step.of('IFCWALL').map((w) => w.id));
      const fillers = [...step.of('IFCDOOR'), ...step.of('IFCWINDOW')];
      const unhosted = fillers.filter((e) => !wallIds.has(step.hostOf(e.id)));
      const typed = fillers.length === 2 && assignedTypes(step, fillers);
      if (!typed) notes.push('Doors and windows are placed without an IfcDoorType / IfcWindowType: the click flow offers no type to place from.');
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: '1 door and 1 window', ok: c.IFCDOOR === 1 && c.IFCWINDOW === 1, detail: `${c.IFCDOOR} doors, ${c.IFCWINDOW} windows` },
          { name: 'each fills its own opening in a wall', ok: fillers.length === 2 && ownOpenings(step,fillers) && unhosted.length === 0, detail: unhosted.length ? `not hosted: #${unhosted.map((e) => e.id).join(', #')}; ${JSON.stringify(c)}` : JSON.stringify(c) },
          { name: 'placed from a door type and a window type', ok: typed, detail: `${c.IFCDOORTYPE} door types, ${c.IFCWINDOWTYPE} window types` },
        ],
      };
    },
  };
