/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { task } from '../lib/driver.mjs';
import { escape, oracleModel, tool } from '../lib/model-ui.mjs';
import { field } from '../lib/authoring-helpers.mjs';


import { near, setupRoom, exportDrawing } from '../lib/probe-helpers.mjs';

// Observe the painted transform only to aim real pointer input, never to author state.
async function drawingPoints(s, entityId = null) {
  return s.state(id => {
    const st = globalThis.__ifc_lite_viewer_store__.getState();
    const drawing = st.drawing2D;
    const canvas = [...document.querySelectorAll('[data-drawing-canvas]')].find(el => {
      const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
    });
    if (!drawing || !canvas) return null;
    const bitmap = canvas.querySelector('canvas');
    const key = bitmap && Object.keys(bitmap).find(key => key.startsWith('__reactFiber$'));
    let fiber = key ? bitmap[key] : null;
    while (fiber && !fiber.memoizedProps?.transform) fiber = fiber.return;
    const transform = fiber?.memoizedProps?.transform;
    if (!transform) return null;
    const rect = canvas.getBoundingClientRect();
    const screen = (x,y) => [rect.x+transform.x+x*transform.scale, rect.y+transform.y+y*transform.scale];
    if (id !== null) {
      const polygon = [...drawing.cutPolygons, ...drawing.projectionPolygons].find(p =>
        (st.resolveGlobalIdFromModels(p.entityId)?.expressId ?? p.entityId) === id);
      if (!polygon) return null;
      const points = polygon.polygon.outer;
      return [screen(points.reduce((sum,p) => sum+p.x,0)/points.length, points.reduce((sum,p) => sum+p.y,0)/points.length)];
    }
    const walls = drawing.cutPolygons.filter(p => p.ifcType.toUpperCase().startsWith('IFCWALL'));
    if (walls.length < 2) return null;
    const centers = walls.map(p => { const xs=p.polygon.outer.map(v => v.x); return (Math.min(...xs)+Math.max(...xs))/2; }).sort((a,b) => a-b);
    const room = drawing.cutPolygons.find(p => p.ifcType.toUpperCase()==='IFCSPACE');
    const ys = room?.polygon.outer.map(p => p.y) ?? [drawing.bounds.min.y,drawing.bounds.max.y];
    const y = (Math.min(...ys)+Math.max(...ys))/2;
    return [screen(centers[0],y), screen(centers.at(-1),y)];
  }, entityId);
}

function dxfLabels(download) {
  if (!download) return [];
  // The real R12 download declares ANSI_1252. Walk group-code/value pairs;
  // a numeric value of zero is not an entity boundary.
  const lines = new TextDecoder('windows-1252').decode(download.bytes).replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/);
  const labels = []; let current = null;
  for (let i=0; i+1<lines.length; i+=2) {
    const code = Number(lines[i].trim()), value = lines[i+1];
    if (!Number.isInteger(code)) return [];
    if (code === 0) {
      if (current) labels.push(current.text);
      current = value === 'TEXT' || value === 'MTEXT' ? { text: '' } : null;
    } else if (current && (code === 1 || code === 3)) current.text += value;
  }
  if (current) labels.push(current.text);
  return labels;
}

export default {
    id: 'ui.drawing-dims',
    capability: 'dimensions-tags',
    title: 'A Distance dimension and live door/space tags on a 2D plan',
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
      tasks.push(await task(s, 'setup: show spaces and generate a plan drawing', async () => {
        if (!(await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().typeVisibility.spaces))) {
          await s.ui.key('Control+k'); await s.ui.type('Spaces');
          await s.ui.click(s.page.getByRole('option', { name: /^Spaces/ }).first());
        }
        await escape(s); await s.ui.key('x', { settle: 600 });
        await s.ui.click(s.page.getByRole('button', { name: 'Down (Z)', exact: true }).first());
        await s.ui.click(s.page.getByRole('button', { name: '2D section', exact: true }).first());
        await s.page.waitForFunction(() => {
          const st = globalThis.__ifc_lite_viewer_store__.getState();
          return st.drawing2DStatus === 'ready' && st.drawing2DPlane?.axis === 'down';
        }, null, { timeout: 30000 });
      }).then(t => Object.assign(t, { setup: true })));
      const plain = await exportDrawing(s, 'svg', { count: false }).catch(() => null);
      tasks.push(await task(s, 'Distance tool, drag from wall to wall, Esc', async () => {
        await s.ui.click(s.page.getByRole('radio', { name: 'Distance', exact: true }));
        const active = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().measure2DMode ?? null);
        if (!active) throw new Error('the Distance tool did not become active');
        const points = await drawingPoints(s);
        if (!points || points.length !== 2) throw new Error('the plan has no two wall axes to measure');
        await s.ui.drag(points[0], points[1]);
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
      tasks.push(await task(s, 'Tag: click the door and the space in the plan', async () => {
        if (!door || !space) throw new Error('the UI did not create a door and space');
        await s.ui.click(s.page.getByRole('radio', { name: 'Tag', exact: true }));
        for (const id of [door.id, space.id]) {
          const points = await drawingPoints(s,id);
          if (!points?.[0]) throw new Error(`no visible drawing footprint for entity #${id}`);
          await s.ui.clickPixel(points[0][0], points[0][1]);
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
        await s.ui.key('Control+k'); await s.ui.type('Properties');
        await s.ui.click(s.page.getByRole('option', { name: 'Properties', exact: true }));
        const attributes = s.page.getByRole('button', { name: /^Attributes/ }).first();
        await attributes.waitFor({ state: 'visible', timeout: 10000 });
        const value = s.page.getByRole('button', { name: String(door.args[2]), exact: true }).last();
        if (!(await value.isVisible())) await s.ui.click(attributes);
        await s.ui.click(value);
        await field(s, s.page.getByRole('textbox', { name: 'Name', exact: true }), 'Parity renamed door');
        renamedSvg = await exportDrawing(s, 'svg');
      }));
      const areaLabel = typeof expectedArea === 'number' ? `≈ ${Number(expectedArea.toFixed(2))} m²` : null;
      const xmlText = text => String(text ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
      const tagged = tags.length === 2 && [door?.id,space?.id].every(id => tags.some(tag => tag.entityId === id && tag.modelId === expectedModelId));
      const dxfTexts = dxfLabels(dxf);
      return {
        tasks, notes: [], evidence: [shot, await s.shot('tags')], artifacts: { svg: renamedSvg ?? taggedSvg ?? svg, dxf },
        checks: [
          { name: 'a dimension was placed in the drawing', ok: annotations > 0, detail: `${annotations} drawing markups in the store` },
          { name: 'dimension measures the 5 m room span', ok: dimensions.length === 1 && near(dimensions[0], 5, 0.25), detail: JSON.stringify(dimensions) },
          { name: 'the exported SVG carries the dimension', ok: added > 0 && numbers > 0, detail: `${added} more SVG characters than before, ${numbers} numeric text labels` },
          { name: 'two tags bind the door and space', ok: tagged, detail: JSON.stringify(tags) },
          { name: 'SVG carries the live door label and exact room quantity', ok: !!taggedSvg && !!expectedDoor && !!expectedSpace && areaLabel !== null && taggedSvg.text.includes('id="element-tags"') && taggedSvg.text.includes(xmlText(expectedDoor)) && taggedSvg.text.includes(xmlText(expectedSpace)) && taggedSvg.text.includes(areaLabel), detail: `${expectedDoor}; ${expectedSpace}; ${areaLabel}` },
          { name: 'Properties rename updates the exported tag', ok: !!renamedSvg && renamedSvg.text.includes('Parity renamed door'), detail: renamedSvg?.name ?? 'no re-export' },
          { name: 'DXF contains both tags as TEXT', ok: dxfTexts.length === 2 && dxfTexts.includes(expectedDoor) && dxfTexts.some(text => text.startsWith(`${expectedSpace} · `) && text.endsWith(`${Number(expectedArea?.toFixed(2))} m²`)), detail: `${dxfTexts.length} TEXT entities` },
        ],
      };
    },
  };
