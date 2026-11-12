import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.roof',
    capability: 'roof-by-footprint',
    title: 'Roof over a 5x4 m footprint (hip expected; #9214)',
    async run(s) {
      const tasks = [await setupRoom(s)];
      const notes = ['The exported roof is meshed and checked against four 30-degree eave planes; its IFC type alone cannot establish a hip.'];
      tasks.push(await task(s, 'Roof tool, typed 5.6 x 4.6 m', async () => {
        await s.ui.key('Shift+Y', { settle: 300 });
        await s.ui.clickWorld([-0.3, -0.3, 3], { modifiers: ['Alt'] });
        await typeFields(s, [5.6, 4.6]);
        await escape(s);
      }));
      await s.harness.aim([14, -12, 12], [2.5, 2, 1.5], { pin: false });
      const shot = await s.shot('roof');
      const { step, text } = await oracleModel(s);
      const roofs = [...step.of('IFCROOF'), ...step.of('IFCSLAB').filter((x) => x.args?.[8]?.enum === 'ROOF')];
      // Reuse the geometric SDK oracle: slabs, full-height prisms and mono-pitch
      // plates cannot pass as a hip even if their IFC label says HIP_ROOF.
      const sloped = roofGeometry(step, await meshIfc(text), {
        footprint: [[-.3,-.3],[5.3,-.3],[5.3,4.3],[-.3,4.3]],
        slopes: Array(4).fill(Math.PI / 6), thickness: .3, hip: true,
      });
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'a roof element exists (IfcRoof or IfcSlab ROOF)', ok: roofs.length >= 1, detail: `${roofs.length} roof elements` },
          { name: 'the roof is sloped (hip by footprint)', ok: sloped === true, detail: sloped === true ? 'four 30-degree planes, low eaves, high centre and volume pass the native-mesh oracle' : sloped },
        ],
      };
    },
  };
