/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { task } from '../lib/driver.mjs';
import { escape, oracleModel, typeFields } from '../lib/model-ui.mjs';


import { near, nearPt, fmt } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.snapping',
    capability: 'snapping-inference',
    title: 'Endpoint and midpoint snaps while drawing',
    async run(s) {
      const tasks = [];
      const glyph = () => s.state(() => [...document.querySelectorAll('[data-snap-kind]')].map((g) => g.getAttribute('data-snap-kind')));
      tasks.push(await task(s, 'setup: wall (0,0)-(5,0) typed', async () => {
        await s.ui.clickWorld([0, 0, 0]);
        await typeFields(s, [5, 0]);
        await escape(s, 1);
      }).then(t => Object.assign(t, { setup: true })));
      let endGlyphs = [];
      let midGlyphs = [];
      tasks.push(await task(s, 'start a wall 80 mm off the endpoint, end it 80 mm off the midpoint', async () => {
        await s.ui.hoverWorld([5.08, 0.08, 0]);
        endGlyphs = await glyph();
        await s.ui.clickWorld([5.08, 0.08, 0]);
        await s.ui.hoverWorld([2.58, 0.08, 0]);
        midGlyphs = await glyph();
        await s.ui.clickWorld([2.58, 0.08, 0]);
        await escape(s);
      }));
      const shot = await s.shot('snap');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
      const [first, second] = axes;
      const end = first?.end ?? [5, 0];
      const mid = first ? [(first.start[0] + first.end[0]) / 2, (first.start[1] + first.end[1]) / 2] : [2.5, 0];
      const notes = [];
      if (second && first && Math.abs(second.start[1] - end[1]) > 0.05 && near(Math.abs(second.start[1] - end[1]), 0.1, 0.01)) {
        notes.push('Endpoint and midpoint snaps pick the corner and edge of the wall body (its face, half the thickness off the axis), not the wall axis end, so a wall started on a snapped end does not continue the first one.');
      }
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'endpoint glyph shown near the wall end', ok: endGlyphs.includes('endpoint'), detail: `glyphs: ${endGlyphs.join(',') || 'none'}` },
          { name: 'second wall starts exactly on the first wall end', ok: !!second && nearPt(second.start, end, 1e-3), detail: second ? `${fmt(second.start)} vs ${fmt(end)}` : 'no second wall' },
          { name: 'midpoint glyph shown near the middle', ok: midGlyphs.includes('midpoint'), detail: `glyphs: ${midGlyphs.join(',') || 'none'}` },
          { name: 'second wall ends exactly on the first wall midpoint', ok: !!second && nearPt(second.end, mid, 1e-3), detail: second ? `${fmt(second.end)} vs ${fmt(mid)}` : 'no second wall' },
        ],
      };
    },
  };
