import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

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
