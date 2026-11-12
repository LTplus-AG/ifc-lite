import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.stair',
    capability: 'stairs-railings',
    title: 'Stair from Level 1 to the storey above, and a railing (two clicks, Enter)',
    async run(s) {
      const tasks = [];
      tasks.push(await task(s, 'setup: add storey above, back to Level 1', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 });
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
      }).then((t) => ({ ...t, setup: true })));
      await s.harness.aim(PLAN_CAM.pos, PLAN_CAM.target);
      tasks.push(await task(s, 'stair: Shift+T, click start and end of the run', async () => {
        await escape(s);
        await tool(s, 'stair.place');
        await s.ui.clickWorld([1, 0, 0]);
        await s.ui.clickWorld([1, 4, 0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'railing: Shift+L, click two points, Enter', async () => {
        await tool(s, 'railing.place');
        await s.ui.clickWorld([3, 0, 0]);
        await s.ui.clickWorld([3, 4, 0]);
        await s.ui.key('Enter', { settle: 300 });
        await escape(s);
      }));
      const notes = [];
      const t = await toasts(s);
      if (t.length) notes.push(`toasts: ${t.join(' / ')}`);
      const shot = await s.shot('stair');
      const { step } = await oracleModel(s);
      const c = step.counts(['IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAILING']);
      const flight = step.of('IFCSTAIRFLIGHT')[0];
      const risers = flight?.args?.[8] ?? null;
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'IfcStair with a flight', ok: c.IFCSTAIR >= 1 && c.IFCSTAIRFLIGHT >= 1, detail: JSON.stringify(c) },
          { name: 'flight rises the 3.0 m storey height (risers x riser height)', ok: !!flight && typeof risers === 'number' && near(risers * (flight.args?.[10] ?? 0), 3, 0.01), detail: flight ? `risers ${risers}, riser height ${flight.args?.[10]}` : 'no flight' },
          { name: 'IfcRailing', ok: c.IFCRAILING >= 1, detail: `${c.IFCRAILING} railings` },
        ],
      };
    },
  };
