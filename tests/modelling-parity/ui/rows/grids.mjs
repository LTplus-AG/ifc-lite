/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import gridColumns from './columns-beams-on-grid-follow-levels.mjs';
import { task } from '../lib/driver.mjs';
import { oracleModel, escape, typeFields } from '../lib/model-ui.mjs';
import { gridCarriedColumn } from '../lib/measured-oracles.mjs';
export default { ...gridColumns, id: 'ui.grids', capability: 'grids', async run(s) {
  const out = await gridColumns.run(s);
  const before = (await oracleModel(s)).step;
  out.tasks.push(await task(s, 'select grid line and Move +1 m X', async () => {
    await escape(s);
    await s.ui.clickWorld([3, 6, 0]);
    const selectedGrid = await s.state(() => {
      const st = globalThis.__ifc_lite_viewer_store__.getState();
      return st.selectedEntityId;
    });
    if (!before.of('IFCGRID').some(g => g.id === selectedGrid)) {
      out.notes.push('Grid lines were not pickable; selecting the grid through Hierarchy.');
      await s.ui.click(s.page.getByRole('button', { name: /Hierarchy/, exact: false }).first());
      await s.ui.click(s.page.getByText('Grid', { exact: true }).last());
    }
    await s.ui.key('Shift+M');
    await typeFields(s, [1, 0]);
    await escape(s);
  }));
  const after = (await oracleModel(s)).step;
  return { ...out, checks: [...out.checks.slice(0,2), { name: 'moving a grid carries its columns', ok: gridCarriedColumn(before, after), detail: JSON.stringify(after.of('IFCCOLUMN').map(c => after.placement(c.id))) }] };
} };
