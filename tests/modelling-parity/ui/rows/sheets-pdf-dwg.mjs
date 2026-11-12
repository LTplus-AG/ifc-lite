import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

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
