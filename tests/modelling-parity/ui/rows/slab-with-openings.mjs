/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { meshIfc, volumeOfParts, containsPoint, bboxOfParts } from '../../probes/sdk/lib/parity.mjs';
import { task } from '../lib/driver.mjs';
import { escape, tool, oracleModel, typeFields } from '../lib/model-ui.mjs';
import { check, field, wall, inspector, body, near, finish } from '../lib/authoring-helpers.mjs';

export default {
    id: 'ui.slab-openings', capability: 'slab-with-openings',
    title: 'Sketch an L slab, cut a shaft, then edit thickness',
    async run(s) {
      const tasks = [await task(s, 'polygon slab, six corners and Enter', async () => {
        await s.ui.click(s.page.getByRole('radio', { name: '3D', exact: true }));
        await tool(s, 'slab.place');
        await s.ui.click(s.page.getByRole('radio', { name: 'Polygon', exact: true }));
        for (const p of [[0,0],[5,0],[5,2],[3,2],[3,4],[0,4]]) await s.ui.clickWorld([...p,0]);
        await s.ui.key('Enter');
        await escape(s);
      })];
      tasks.push(await task(s, 'opening tool: type 1.5 by 2 m and cut an enclosed shaft', async () => {
        await tool(s, 'opening.place');
        await s.ui.hoverWorld([2,2,0]);
        await s.shot('shaft-ghost');
        await typeFields(s, [1.5, 2], { enter: false });
        await s.ui.key('Tab'); // Apply Depth and return to Width without placing.
        await s.ui.clickWorld([2,2,0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'select slab and change thickness to 0.3 m', async () => {
        await s.ui.clickWorld([2.5,.5,0]);
        await inspector(s);
        await field(s, s.page.getByLabel('Thickness in metres', { exact: true }), 0.3);
      }));
      await s.shot('before-export');
      const { step, text } = await oracleModel(s);
      const meshes = await meshIfc(text);
      const shaftSlab = step.of('IFCSLAB')[0];
      const parts = meshes.get(shaftSlab?.id)?.parts ?? [];
      const bounds = bboxOfParts(parts), volume = volumeOfParts(parts);
      const empty = parts.length > 0 && !containsPoint(parts, [1.75,2,(bounds.min[2]+bounds.max[2])/2])
        && containsPoint(parts, [3.5,1,(bounds.min[2]+bounds.max[2])/2]);
      await s.harness.aim([7,-8,9], [2,1.5,0]);
      await s.shot('shaft-through-thickened-slab-3d');
      await tool(s, 'opening.place');
      await escape(s);
      await s.ui.click(s.page.getByRole('radio', { name: 'Plan', exact: true }));
      await s.settle(2000);
      const planHole = await s.state(() => {
        const lines = [...document.querySelectorAll('[data-plan-layer="projection"] line')].map(e =>
          ['x1','y1','x2','y2'].map(k => +e.getAttribute(k)));
        // A closed 1.5:2 rectangle, distinct from the L outline. Deduplicate
        // coincident projected edges and allow collinear mesh subdivisions.
        const key = (x,y) => `${x.toFixed(2)},${y.toFixed(2)}`;
        const unique = new Map();
        for (const [x,y,u,v] of lines) {
          const a = key(x,y), b = key(u,v);
          if (a !== b) unique.set([a,b].sort().join('|'), [a,b]);
        }
        const edges = [...unique.values()];
        const remaining = new Set(edges.flat());
        while (remaining.size) {
          const seen = new Set(), todo = [remaining.values().next().value];
          while (todo.length) {
            const p = todo.pop(); if (seen.has(p)) continue;
            seen.add(p); remaining.delete(p);
            for (const [a,b] of edges) { if (a===p) todo.push(b); if (b===p) todo.push(a); }
          }
          if (seen.size < 4 || ![...seen].every(p => edges.filter(e => e.includes(p)).length===2)) continue;
          const points = [...seen].map(p => p.split(',').map(Number));
          const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          const onBox = points.every(([x,y]) => Math.min(Math.abs(x-x0), Math.abs(x-x1), Math.abs(y-y0), Math.abs(y-y1)) < .02);
          if (onBox && y1 > y0 && Math.abs((x1-x0)/(y1-y0) - .75) < .02) return true;
        }
        return false;
      });
      await s.shot('shaft-through-thickened-slab-plan');
      const slab = step.of('IFCSLAB')[0];
      const solid = step.get(body(step, slab)?.args[3]?.[0]);
      const profile = step.get(solid?.args[0]);
      const points = step.get(profile?.args[2])?.args[0] ?? [];
      const voids = step.of('IFCRELVOIDSELEMENT').filter((r) => r.args[4]?.ref === slab?.id);
      const openings = voids.map(r => step.get(r.args[5]));
      const hosted = openings.length === 1 && openings.every(o => o?.type === 'IFCOPENINGELEMENT'
        && step.get(o.args[5])?.args[0]?.ref === slab?.args[5]?.ref);
      return finish(s, tasks, [
        check('one L-shaped slab with six corners', step.count('IFCSLAB') === 1 && points.length >= 6, `${step.count('IFCSLAB')} slabs, ${points.length} profile points`),
        check('shaft remains hosted in slab after thickening', hosted && near(solid?.args[3], .3), `${voids.length} slab voids to ${openings.map(o => o?.type).join(',')}; thickness ${solid?.args[3]}; host-relative ${hosted}`),
        check('shaft geometry is empty in 3D', empty && Math.abs(volume - (16-3)*.3) < .039, `volume ${volume}, expected 3.9; void ${empty}`),
        check('plan displays a closed shaft outline', planHole, 'Plan projects the slab below the standard 1.2 m cut; a closed rectangular shaft outline with the 1.5:2 aspect ratio is visible'),
      ]);
    },
  };
