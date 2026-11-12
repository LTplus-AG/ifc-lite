import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.typed-dims',
    capability: 'typed-input-temp-dims',
    title: 'Typed lengths and angles for walls, typed width and depth for a slab',
    async run(s) {
      const tasks = [];
      tasks.push(await task(s, 'walls 5/4/5/4 m typed with angles', () => typedRoom(s, [0, 0], 5, 4)));
      tasks.push(await task(s, 'slab 5x4 m typed', async () => {
        await tool(s, 'slab.place');
        await s.ui.clickWorld([8, 0, 0]);
        await typeFields(s, [5, 4]);
        await escape(s);
      }));
      const shot = await s.shot('typed');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
      const want = [5, 4, 5, 4];
      const slab = step.of('IFCSLAB')[0];
      const q = slab ? step.quantities(slab.id) : {};
      const notes = [];
      const hud = await hudText(s);
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'wall lengths exactly 5, 4, 5, 4 m', ok: axes.length === 4 && axes.every((a, i) => near(a.length, want[i], 1e-3)), detail: axes.map((a) => a.length.toFixed(4)).join(', ') },
          { name: 'typed chain closes on the start point', ok: axes.length === 4 && nearPt(axes[0].start, axes[3].end, 1e-3), detail: axes.length ? `${fmt(axes[0].start)} vs ${fmt(axes.at(-1).end)}` : 'no walls' },
          { name: 'slab 5 x 4 m (GrossArea 20 m2)', ok: near(q.GrossArea ?? 0, 20, 1e-3), detail: JSON.stringify({ Length: q.Length, Depth: q.Depth, GrossArea: q.GrossArea }) },
        ],
        extra: { hud },
      };
    },
  };
