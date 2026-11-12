import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.wall-chain',
    capability: 'wall-chains-autojoin',
    title: 'Draw a closed 5x4 m wall chain by clicking corners',
    async run(s) {
      const pts = [[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]];
      const tasks = [];
      tasks.push(await task(s, 'click 5 corners (wall tool already active after Start blank)', async () => {
        for (const p of pts) await s.ui.clickWorld([p[0], p[1], 0]);
        await escape(s);
      }));
      const shot = await s.shot('chain');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
      const joins = uniqueWallJoins(step);
      const tol = 0.05;
      const closed = axes.length >= 4 && nearPt(axes[0].start, axes.at(-1).end, 1e-6);
      const onTarget = axes.length === 4 && axes.every((a, i) => nearPt(a.start, pts[i], tol) && nearPt(a.end, pts[i + 1], tol));
      const notes = [];
      if (s.counters.cameraJumps) notes.push(`The camera moved by itself ${s.counters.cameraJumps} time(s) while drawing (it reframes after a commit), so the next click would land on a wall face instead of the floor.`);
      const off = axes.map((a, i) => (pts[i] ? Math.hypot(a.start[0] - pts[i][0], a.start[1] - pts[i][1]) : 0));
      if (off.some((d) => d > 0.005)) notes.push(`Clicked corners land off the intended metre points by up to ${(Math.max(...off) * 1000).toFixed(0)} mm: no snap to round increments or a grid on a blank model.`);
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: '4 walls', ok: axes.length === 4, detail: `${axes.length} walls` },
          { name: 'corners within 50 mm of the clicked points', ok: onTarget, detail: axes.map((a) => `${fmt(a.start)}->${fmt(a.end)}`).join(' ') },
          { name: 'loop closed exactly (snapped to the first point)', ok: closed, detail: closed ? 'closed' : 'open' },
          { name: 'corners auto-joined (4 IfcRelConnectsPathElements)', ok: joins >= 4 && wallEndpointsJoined(step), detail: `${joins} joins` },
        ],
        metrics: { cameraJumps: s.counters.cameraJumps },
      };
    },
  };
