/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { checkSheetDxf } from '../../output/sheet-dxf.mjs';
import { task } from '../lib/driver.mjs';



import { setupRoom, openFrontSection, drawingState, exportDrawing, isPdf } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.sheet',
    capability: 'sheets-pdf-dwg',
    title: 'Put the 2D section on a sheet and export the sheet as PDF and DXF',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'setup: 2D section of the room', () => openFrontSection(s)).then(t => Object.assign(t, { setup: true })));
      tasks.push(await task(s, 'Distance: drag between the outer cut wall faces', async () => {
        await s.ui.click(s.page.getByRole('radio', { name: 'Distance', exact: true }));
        const points = await s.state(() => {
          const st = globalThis.__ifc_lite_viewer_store__.getState();
          const canvas = [...document.querySelectorAll('[data-drawing-canvas]')].find(el => el.getBoundingClientRect().width > 0);
          const bitmap = canvas?.querySelector('canvas');
          const key = bitmap && Object.keys(bitmap).find(key => key.startsWith('__reactFiber$'));
          let fiber = key ? bitmap[key] : null;
          let root = fiber;
          while (root?.return) root = root.return;
          if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber.alternate ?? fiber;
          while (fiber && !fiber.memoizedProps?.transform) fiber = fiber.return;
          const transform = fiber?.memoizedProps?.transform;
          const walls = st.drawing2D?.cutPolygons.filter(p => p.ifcType.toUpperCase().startsWith('IFCWALL')) ?? [];
          if (!transform || walls.length < 2) return null;
          const centers = walls.map(p => {
            const xs = p.polygon.outer.map(v => v.x), ys = p.polygon.outer.map(v => v.y);
            return { x: (Math.min(...xs)+Math.max(...xs))/2, y: (Math.min(...ys)+Math.max(...ys))/2, minX: Math.min(...xs), maxX: Math.max(...xs) };
          }).sort((a,b) => a.x-b.x);
          const rect = canvas.getBoundingClientRect();
          return [{ ...centers[0], x: centers[0].minX }, { ...centers.at(-1), x: centers.at(-1).maxX }].map(p => [rect.x+transform.x+p.x*transform.scale, rect.y+transform.y-p.y*transform.scale]);
        });
        if (!points) throw new Error('No painted cut-wall axes to dimension');
        await s.ui.drag(points[0], points[1]);
        const dimensions = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().measure2DResults.map(result => result.distance));
        if (dimensions.length !== 1 || Math.abs(dimensions[0]-5.2) > .01) throw new Error(`Expected one committed 5.2 m dimension, got ${JSON.stringify(dimensions)}`);
        await s.ui.key('Escape');
      }));
      tasks.push(await task(s, 'Sheet, Enable Sheet', async () => {
        await s.ui.click(s.page.getByRole('button', { name: 'Sheet', exact: true }).first(), { settle: 800 });
        await s.ui.click(s.page.getByRole('button', { name: 'Enable Sheet' }), { settle: 1500 });
        await s.ui.click(s.page.getByRole('combobox').filter({ hasText: '1:100' }).first());
        await s.ui.click(s.page.getByRole('option', { name: /^1:50 -/ }), { settle: 800 });
      }));
      const state = await drawingState(s);
      const sheetScale = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().activeSheet?.scale.factor);
      const shot = await s.shot('sheet');
      const files = {};
      tasks.push(await task(s, 'Drawing > Export > PDF (the sheet)', async () => { files.pdf = await exportDrawing(s, 'pdf'); }));
      tasks.push(await task(s, 'Drawing > Export > DXF', async () => { files.dxf = await exportDrawing(s, 'dxf'); }));
      const dxf = checkSheetDxf(files.dxf?.bytes);
      return {
        tasks, notes: [`Independent DXF reader: ${dxf.reader} ${dxf.version ?? 'unavailable'}; DXF model metres, paper comparison at 1:50.`], evidence: [shot], artifacts: files,
        checks: [
          { name: 'a sheet is active (paper, frame, title block)', ok: state.sheetEnabled && state.activeSheet, detail: `sheetEnabled ${state.sheetEnabled}, activeSheet ${state.activeSheet}` },
          { name: 'sheet uses 1:50 for the 104 mm comparison', ok: sheetScale === 50, detail: String(sheetScale) },
          { name: 'sheet exported as PDF', ok: isPdf(files.pdf), detail: files.pdf ? `${files.pdf.name}, ${files.pdf.bytes.length} bytes` : 'no PDF' },
          ...dxf.checks.map(check => ({ ...check, detail: JSON.stringify(dxf) })),
        ],
      };
    },
  };
