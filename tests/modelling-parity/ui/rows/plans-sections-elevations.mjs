/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pdfPathExtents, sectionSpanMm } from '../lib/pdf-geometry.mjs';

import { task } from '../lib/driver.mjs';
import { tool } from '../lib/model-ui.mjs';


import { setupRoom, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.plan-section',
    capability: 'plans-sections-elevations',
    title: 'Show the plan, then a 2D section drawing',
    async run(s) {
      const tasks = [await setupRoom(s)];
      let planPaths = 0;
      const notes = [];
      tasks.push(await task(s, 'choose Plan layout', async () => {
        await s.ui.click(s.page.getByRole('radio', { name: 'Plan', exact: true }));
        await s.settle(1500);
        planPaths = await s.state(() => document.querySelectorAll('svg[data-plan-canvas] path, svg[data-plan-canvas] polygon, svg[data-plan-canvas] line, svg[data-plan-canvas] polyline, svg[data-plan-canvas] rect').length);
      }));
      const planShot = await s.shot('plan');
      tasks.push(await task(s, 'Section tool (X), New cut: Front, then the 2D section toggle', () => openFrontSection(s)));
      const section = await drawingState(s);
      const sectionShot = await s.shot('section');
      const files = {};
      for (const format of ['svg', 'dxf', 'pdf']) {
        tasks.push(await task(s, `Drawing > Export > ${format.toUpperCase()}`, async () => { files[format] = await exportDrawing(s, format); }));
      }
      let extents = [];
      tasks.push(await task(s, 'measure PDF paths in millimetres', async () => { extents = await pdfPathExtents(files.pdf.bytes); }));
      let elevation = null;
      tasks.push(await task(s, 'generate elevation linework', async () => {
        await s.ui.click(s.page.getByRole('button', { name: 'Projection', exact: true }).first(), { settle: 3000 });
        elevation = await drawingState(s);
      }));
      return {
        tasks, notes, evidence: [planShot, sectionShot], artifacts: files,
        checks: [
          { name: 'plan view shows the walls', ok: planPaths >= 4, detail: `${planPaths} plan shapes` },
          { name: '2D section drawing shows the cut walls', ok: section.panel && section.cutPolygons >= 2, detail: `status ${section.status}, panel ${section.panel}, ${section.cutPolygons} cut polygons, ${section.lines} lines` },
          { name: 'section exported as SVG with geometry', ok: svgShapes(files.svg) >= 2, detail: files.svg ? `${files.svg.name}, ${svgShapes(files.svg)} shapes` : 'no SVG' },
          { name: 'section exported as DXF', ok: isDxf(files.dxf), detail: files.dxf ? `${files.dxf.name}, ${files.dxf.bytes.length} bytes` : 'no DXF' },
          { name: 'section exported as PDF', ok: isPdf(files.pdf), detail: files.pdf ? `${files.pdf.name}, ${files.pdf.bytes.length} bytes` : 'no PDF' },
          { name: 'elevation contains linework', ok: !!elevation && elevation.lines > 0, detail: JSON.stringify(elevation) },
          { name: 'PDF geometry is at the requested drawing scale', ok: Math.abs(sectionSpanMm(extents) - 104) <= .5, detail: JSON.stringify(extents) },
        ],
      };
    },
  };
