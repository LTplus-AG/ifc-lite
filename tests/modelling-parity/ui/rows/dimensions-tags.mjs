import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';
import { escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields } from '../lib/model-ui.mjs';
import { readStep } from '../lib/step.mjs';
import { meshIfc } from '../../probes/sdk/lib/parity.mjs';
import { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.drawing-dims',
    capability: 'dimensions-tags',
    title: 'A Distance dimension on the 2D section, exported to SVG; element tags',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'setup: 2D section of the room', () => openFrontSection(s)).then((t) => ({ ...t, setup: true })));
      const plain = await exportDrawing(s, 'svg', { count: false }).catch(() => null);
      let toolbar = [];
      let canvas = null;
      tasks.push(await task(s, 'Distance tool, drag from wall to wall, Esc', async () => {
        const { page } = s;
        toolbar = await s.state(() => [...document.querySelectorAll('button,[role=radio]')].filter((b) => b.offsetParent && b.getBoundingClientRect().top > innerHeight * 0.55 && b.getBoundingClientRect().top < innerHeight * 0.65).map((b) => b.innerText.trim()).filter(Boolean));
        // The Drawing toolbar's markup tool (the section HUD has its own "distance" field, hence the exact text).
        await s.ui.click(page.getByText('Distance', { exact: true }).last());
        const active = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().measure2DMode ?? null);
        if (!active) throw new Error('the Distance tool did not become active');
        // The drawing canvas fills the panel; the fitted front section puts the two cut walls at
        // these fractions of its width (measured at 1600x900 on the baseline).
        canvas = await s.state(() => {
          const c = [...document.querySelectorAll('canvas, svg')].filter((x) => x.getBoundingClientRect().top > innerHeight * 0.58 && x.getBoundingClientRect().width > 600)
            .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, tag: c.tagName };
        });
        if (!canvas) throw new Error('no drawing canvas found');
        const y = canvas.y + canvas.h * 0.5;
        // A 2D distance is one press-drag-release from wall to wall.
        await s.ui.drag([canvas.x + canvas.w * 0.351, y], [canvas.x + canvas.w * 0.649, y]);
        await s.ui.key('Escape');
      }));
      const shot = await s.shot('dimension');
      const dimensions = await s.state(() =>
        (globalThis.__ifc_lite_viewer_store__.getState().measure2DResults ?? []).map((m) => m.distance));
      const annotations = dimensions.length;
      let svg = null;
      tasks.push(await task(s, 'Drawing > Export > SVG', async () => { svg = await exportDrawing(s, 'svg'); }));
      const added = svg && plain ? svg.text.length - plain.text.length : 0;
      const numbers = (svg?.text.match(/<text[^>]*>[^<]*\d+[.,]\d+[^<]*<\/text>/g) ?? []).length;
      const tagTool = toolbar.some((t) => /tag|label/i.test(t));
      return {
        tasks, notes: tagTool ? [] : [`The Drawing toolbar has no tag tool (${toolbar.join(', ')}).`], evidence: [shot], artifacts: { svg },
        checks: [
          { name: 'a dimension was placed in the drawing', ok: annotations > 0, detail: `${annotations} drawing markups in the store` },
          { name: 'dimension measures the 5 m room span', ok: dimensions.length === 1 && near(dimensions[0], 5, 0.25), detail: JSON.stringify(dimensions) },
          { name: 'the exported SVG carries the dimension', ok: added > 0 && numbers > 0, detail: `${added} more SVG characters than before, ${numbers} numeric text labels` },
          { name: 'a tag tool for elements (door, window, room tags)', ok: false, detail: tagTool ? 'tag control found, but no entity-bound tag placement/export oracle has passed' : `no tag control in toolbar: ${toolbar.join(', ')}` },
        ],
      };
    },
  };
