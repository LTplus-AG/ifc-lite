/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { task } from '../lib/driver.mjs';
import { escape, oracleModel, tool } from '../lib/model-ui.mjs';
import { field } from '../lib/authoring-helpers.mjs';


import { near, setupRoom, openFrontSection, exportDrawing } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.drawing-dims',
    capability: 'dimensions-tags',
    title: 'A Distance dimension on the 2D section, exported to SVG; element tags',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'place a door and an enclosed space', async () => {
        await tool(s, 'door.place'); await s.ui.clickWorld([2.5, 0, 1]); await escape(s);
        await tool(s, 'room.place'); await s.ui.clickWorld([2.5, 2, 0]); await escape(s);
      }));
      const initialModel = (await oracleModel(s)).step;
      const door = initialModel.of('IFCDOOR')[0];
      const space = initialModel.of('IFCSPACE')[0];
      const expectedArea = space ? initialModel.quantities(space.id).NetFloorArea : null;
      const expectedDoor = door?.args[7] || door?.args[2];
      const expectedSpace = space?.args[2];
      const expectedModelId = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().session?.modelId);
      tasks.push(await task(s, 'setup: 2D section of the room', () => openFrontSection(s)).then(t => Object.assign(t, { setup: true })));
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
      let tags = [], taggedSvg = null, renamedSvg = null, dxf = null;
      tasks.push(await task(s, 'show space volumes and generate a plan drawing', async () => {
        if (!(await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().typeVisibility.spaces))) {
          await s.ui.key('Control+k'); await s.ui.type('Spaces');
          await s.ui.click(s.page.getByRole('option', { name: /^Spaces/ }).first());
        }
        await s.ui.key('Escape');
        await s.ui.click(s.page.locator('[data-testid=section-add-plane]'));
        await s.ui.click(s.page.getByRole('menuitem', { name: 'Down (Z)', exact: true }));
        await s.page.waitForFunction(() => {
          const st = globalThis.__ifc_lite_viewer_store__.getState();
          return st.drawing2DStatus === 'ready' && st.drawing2DPlane?.axis === 'down';
        }, null, { timeout: 30000 });
      }));
      tasks.push(await task(s, 'Tag: click the door and the space in the plan', async () => {
        if (!door || !space) throw new Error('the UI did not create a door and space');
        await s.ui.click(s.page.getByRole('radio', { name: 'Tag', exact: true }));
        for (const id of [door.id, space.id]) {
          const point = await s.state(id => {
            const st = globalThis.__ifc_lite_viewer_store__.getState();
            const polygon = [...st.drawing2D.cutPolygons, ...st.drawing2D.projectionPolygons].find(p => {
              const ref = st.resolveGlobalIdFromModels(p.entityId);
              return (ref?.expressId ?? p.entityId) === id;
            });
            const canvas = document.querySelector('[data-drawing-canvas]');
            if (!polygon || !canvas) return null;
            const points = polygon.polygon.outer;
            const x = points.reduce((v,p) => v+p.x,0)/points.length;
            const y = points.reduce((v,p) => v+p.y,0)/points.length;
            const rect = canvas.getBoundingClientRect();
            // Observe the mounted canvas transform solely to aim real input.
            const bitmap = canvas.querySelector('canvas');
            const key = bitmap && Object.keys(bitmap).find(key => key.startsWith('__reactFiber$'));
            let fiber = key ? bitmap[key] : null;
            while (fiber && !fiber.memoizedProps?.transform) fiber = fiber.return;
            const t = fiber?.memoizedProps?.transform;
            if (!t) return null;
            return { x: rect.x+t.x+x*t.scale, y: rect.y+t.y+y*t.scale };
          }, id);
          if (!point) throw new Error(`no visible drawing footprint for entity #${id}`);
          await s.ui.clickPixel(point.x, point.y);
        }
        await s.ui.key('Escape');
        tags = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().tagAnnotations2D ?? []);
        taggedSvg = await exportDrawing(s, 'svg');
        dxf = await exportDrawing(s, 'dxf');
      }));
      tasks.push(await task(s, 'rename the door through Properties and re-export the drawing', async () => {
        // Hide room volumes so the door remains pickable through the 3D canvas.
        await s.ui.key('Control+k'); await s.ui.type('Spaces');
        await s.ui.click(s.page.getByRole('option', { name: /^Spaces/ }).first());
        await escape(s); await s.ui.clickWorld([2.5, 0, 1]);
        const selected = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntity?.expressId);
        if (selected !== door?.id) throw new Error(`picked #${selected}, expected the door #${door?.id}`);
        await s.ui.click(s.page.locator('[data-model-inspector]').getByRole('button', { name: 'Properties', exact: true }));
        await s.ui.click(s.page.getByRole('button', { name: String(door.args[2]), exact: true }).last());
        await field(s, s.page.getByRole('textbox', { name: 'Name', exact: true }), 'Parity renamed door');
        renamedSvg = await exportDrawing(s, 'svg');
      }));
      const areaLabel = typeof expectedArea === 'number' ? `≈ ${Number(expectedArea.toFixed(2))} m²` : null;
      const xmlText = text => String(text ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
      const tagged = tags.length === 2 && [door?.id,space?.id].every(id => tags.some(tag => tag.entityId === id && tag.modelId === expectedModelId));
      const dxfTexts = (dxf?.text ?? '').split(/\r?\n0\r?\n/).filter(record => /^TEXT\r?\n/.test(record));
      return {
        tasks, notes: [], evidence: [shot, await s.shot('tags')], artifacts: { svg: renamedSvg ?? taggedSvg ?? svg, dxf },
        checks: [
          { name: 'a dimension was placed in the drawing', ok: annotations > 0, detail: `${annotations} drawing markups in the store` },
          { name: 'dimension measures the 5 m room span', ok: dimensions.length === 1 && near(dimensions[0], 5, 0.25), detail: JSON.stringify(dimensions) },
          { name: 'the exported SVG carries the dimension', ok: added > 0 && numbers > 0, detail: `${added} more SVG characters than before, ${numbers} numeric text labels` },
          { name: 'two tags bind the door and space', ok: tagged, detail: JSON.stringify(tags) },
          { name: 'SVG carries the live door label and exact room quantity', ok: !!taggedSvg && !!expectedDoor && !!expectedSpace && areaLabel !== null && taggedSvg.text.includes('id="element-tags"') && taggedSvg.text.includes(xmlText(expectedDoor)) && taggedSvg.text.includes(xmlText(expectedSpace)) && taggedSvg.text.includes(areaLabel), detail: `${expectedDoor}; ${expectedSpace}; ${areaLabel}` },
          { name: 'Properties rename updates the exported tag', ok: !!renamedSvg && renamedSvg.text.includes('Parity renamed door'), detail: renamedSvg?.name ?? 'no re-export' },
          { name: 'DXF contains both tags as TEXT', ok: dxfTexts.some(text => text.includes(String(expectedDoor))) && dxfTexts.some(text => text.includes(String(expectedSpace)) && text.includes(String(Number(expectedArea?.toFixed(2))))), detail: `${dxfTexts.length} TEXT entities` },
        ],
      };
    },
  };
