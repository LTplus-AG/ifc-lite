/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { hasDwgDownload } from '../lib/oracles.mjs';
import { task } from '../lib/driver.mjs';



import { setupRoom, openFrontSection, drawingState, exportDrawing, isPdf, isDxf } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.sheet',
    capability: 'sheets-pdf-dwg',
    title: 'Put the 2D section on a sheet and export the sheet as PDF and DXF',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'setup: 2D section of the room', () => openFrontSection(s)).then((t) => ({ ...t, setup: true })));
      tasks.push(await task(s, 'Sheet, Enable Sheet', async () => {
        await s.ui.click(s.page.getByRole('button', { name: 'Sheet', exact: true }).first(), { settle: 800 });
        await s.ui.click(s.page.getByRole('button', { name: 'Enable Sheet' }), { settle: 1500 });
      }));
      const state = await drawingState(s);
      const shot = await s.shot('sheet');
      const files = {};
      tasks.push(await task(s, 'Drawing > Export > PDF (the sheet)', async () => { files.pdf = await exportDrawing(s, 'pdf'); }));
      tasks.push(await task(s, 'Drawing > Export > DXF', async () => { files.dxf = await exportDrawing(s, 'dxf'); }));
      return {
        tasks, notes: ['The drawing exports DXF; there is no DWG export.'], evidence: [shot], artifacts: files,
        checks: [
          { name: 'a sheet is active (paper, frame, title block)', ok: state.sheetEnabled && state.activeSheet, detail: `sheetEnabled ${state.sheetEnabled}, activeSheet ${state.activeSheet}` },
          { name: 'sheet exported as PDF', ok: isPdf(files.pdf), detail: files.pdf ? `${files.pdf.name}, ${files.pdf.bytes.length} bytes` : 'no PDF' },
          { name: 'drawing exported as DXF (no DWG export exists)', ok: isDxf(files.dxf), detail: files.dxf ? `${files.dxf.name}, ${files.dxf.bytes.length} bytes` : 'no DXF' },
          { name: 'drawing exported as DWG', ok: hasDwgDownload(files.dwg), detail: files.dwg?.name ?? 'no DWG export exists' },
        ],
      };
    },
  };
