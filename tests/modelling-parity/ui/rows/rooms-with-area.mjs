import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.rooms',
    capability: 'rooms-with-area',
    title: 'Room by clicking inside four walls; area from the inner faces',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'room: Shift+O, click inside', async () => {
        await tool(s, 'room.place');
        await s.ui.clickWorld([2.5, 2, 0]);
        await escape(s);
      }));
      const shot = await s.shot('room');
      const { step } = await oracleModel(s);
      const spaces = step.of('IFCSPACE');
      const q = spaces[0] ? step.quantities(spaces[0].id) : {};
      const area = q.NetFloorArea ?? q.GrossFloorArea ?? null;
      const inner = 4.8 * 3.8;
      return {
        tasks, notes: [], evidence: [shot],
        checks: [
          { name: 'one IfcSpace', ok: spaces.length === 1, detail: `${spaces.length}` },
          { name: `floor area quantity ${inner.toFixed(2)} m2 (inner faces)`, ok: area !== null && near(area, inner, 0.05), detail: JSON.stringify(q) },
        ],
      };
    },
  };
