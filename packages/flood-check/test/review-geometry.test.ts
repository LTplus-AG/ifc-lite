/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CodeRabbit's review of #10403 at 29ec1fb: geometry the readers reported as
 * complete although it was not (an arc between its sampled points, an oblique
 * slab extrusion, a clipped body's centre), and a nested element that
 * resolved to no storey.
 */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { curvePoints } from '../src/model/outline.js';
import type { ModelReader } from '../src/model/reader.js';
import { mapOf, parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

/** Distance from p to the polyline. */
function toPolyline(p: [number, number], pts: Array<[number, number]>): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
  }
  return best;
}

describe('an arc is traced along its whole length, not only at its axis extremes', () => {
  it('the polyline of a quarter arc of radius 10 stays within 1 mm of the arc everywhere, so no rotation can cut it short', () => {
    // The arc from (0, 0) through (10 - 5√2, -5√2) to (10, -10): centre (10, 0), from 180° to 270°.
    const s = 5 * Math.SQRT2;
    const list = { type: 'IFCCARTESIANPOINTLIST2D', attributes: [[[0, 0], [10 - s, -s], [10, -10]], null] };
    const reader = { entity: (id: number | null) => (id === 1 ? { type: 'IFCINDEXEDPOLYCURVE', attributes: [2, [['IFCARCINDEX', [1, 2, 3]]], null] } : id === 2 ? list : null) } as unknown as ModelReader;
    const pts = curvePoints(reader, 1)! as Array<[number, number]>;
    let worst = 0;
    for (let k = 0; k <= 1000; k++) {
      const t = Math.PI + (Math.PI / 2) * (k / 1000);
      worst = Math.max(worst, toPolyline([10 + 10 * Math.cos(t), 10 * Math.sin(t)], pts));
    }
    expect(worst).toBeLessThan(1e-3);
    // Conservative in every frame (CodeRabbit's follow-up: on-arc points alone fell 0.49 mm short after a 45° turn): in each
    // of 32 directions the points reach at least as far as the arc does.
    for (let k = 0; k < 32; k++) {
      const u = [Math.cos((2 * Math.PI * k) / 32), Math.sin((2 * Math.PI * k) / 32)];
      let arc = -Infinity;
      for (let j = 0; j <= 2000; j++) {
        const t = Math.PI + (Math.PI / 2) * (j / 2000);
        arc = Math.max(arc, (10 + 10 * Math.cos(t)) * u[0] + 10 * Math.sin(t) * u[1]);
      }
      const reach = Math.max(...[[0, 0] as [number, number], ...pts].map((p) => p[0] * u[0] + p[1] * u[1]));
      expect(reach, `direction ${k}`).toBeGreaterThanOrEqual(arc - 1e-9);
    }
  });
});

describe('a ground slab extruded obliquely', () => {
  it('is not read as its base profile alone: the footprint is partial and names the slab', async () => {
    const facts = await extract((b) => {
      const solid = b.rectExtrusion(25, 5, 10, 10, 10, b.axis(0, 0, 0), b.dir(1, 0, 1));
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte schräg',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
    });
    expect(facts.footprint.partial).toBe(true);
    expect(facts.footprint.quality?.unreadable.map((u) => u.ifcClass)).toContain('IfcSlab');
  });
});

describe('a clipped body bounds the level but not the position', () => {
  it('an opening whose body is a DIFFERENCE is kept: its first operand\'s centre is not where the opening is', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const wall = b.add(`IFCWALL(${b.guid()},$,'Wand ohne Pset',$,$,#${b.place(eg.pl, 0, 0, 0)},$,$,.STANDARD.)`);
      b.contain(eg.id, wall);
      // First operand x 0..20 at y 5; the subtracted box x 0..19 leaves the strip at x 19..20, on the east façade.
      const first = b.rectExtrusion(10, 5, 20, 0.4, 1, b.axis(0, 0, 0.5), b.dir(0, 0, 1));
      const cut = b.rectExtrusion(9.5, 5, 19, 1, 2, b.axis(0, 0, 0), b.dir(0, 0, 1));
      const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${first},#${cut})`);
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung geschnitten',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([body])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
    });
    const o = facts.candidates.find((c) => c.name === 'Öffnung geschnitten');
    expect(o?.selectedBecause).toMatch(/position is uncertain/);
  });
});

describe('a door nested into a curtain wall', () => {
  it('resolves to the curtain wall\'s storey', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const cw = b.add(`IFCCURTAINWALL(${b.guid()},$,'Pfosten-Riegel',$,$,#${b.place(eg.pl, 0, 0, 0)},$,$,.NOTDEFINED.)`);
      b.contain(eg.id, cw);
      const leaf = b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))]);
      const door = b.add(`IFCDOOR(${b.guid()},$,'Tür Glasfassade',$,$,#${b.place(eg.pl, 15, 10, 0)},#${leaf},$,2.1,1.,.DOOR.,$,$)`);
      b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.add(`IFCRELNESTS(${b.guid()},$,$,$,#${cw},(#${door}))`);
    });
    const eg = facts.storeys.find((s) => s.name === 'EG')!;
    expect(facts.candidates.find((c) => c.name === 'Tür Glasfassade')?.storeyId).toBe(eg.expressId);
  });
});

describe('the automated review of 0b30b84: position quality reaches the fact; a courtyard is open ground everywhere', () => {
  it('an opening placed by a clipped body carries an uncertain position into its fact, not only into the façade test', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
      b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(eg.id, wall);
      const first = b.rectExtrusion(19.8, 5, 0.4, 2, 1, b.axis(0, 0, 0.5), b.dir(0, 0, 1));
      const cut = b.rectExtrusion(19.8, 4.5, 1, 1, 2, b.axis(0, 0, 0), b.dir(0, 0, 1));
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung geschnitten',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${first},#${cut})`)])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
    });
    const o = facts.candidates.find((c) => c.name === 'Öffnung geschnitten')!;
    expect(o).toMatchObject({ positionIsUncertain: true, levelIsUpperEstimate: false });
    expect(o.notes?.join()).toMatch(/position/);
  });

  it('an external ramp descending inside a given courtyard ring, with no IsExternal, is kept as outside the footprint', async () => {
    const ring = (pts: Array<[number, number]>) => pts.map(([x, y]) => mapOf(x, y));
    const store = await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        const body = b.shape([b.rectExtrusion(0, 0, 2, 3, 1.5, b.axis(0, 0, -1.5), b.dir(0, 0, 1))]);
        b.contain(b.storeys.eg.id, b.add(`IFCRAMP(${b.guid()},$,'Hoframpe',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},#${body},$,.STRAIGHT_RUN_RAMP.)`));
      },
    }));
    const facts = extractModelFacts(store, {
      expectedCrs: 'EPSG:2056',
      groundStorey: 'EG',
      footprint: [ring([[0, 0], [20, 0], [20, 10], [0, 10]]), ring([[6, 2], [14, 2], [14, 8], [6, 8]])],
    });
    expect(facts.candidates.find((c) => c.name === 'Hoframpe')?.selectedBecause).toMatch(/placed outside the footprint/);
  });

  it('a finish slab lying within the structural slab (inset 5 cm) is not a courtyard: slabs never draw holes', async () => {
    const facts = await extract((b) => {
      const solid = b.rectExtrusion(10, 5, 19.9, 9.9, 0.1, b.axis(0, 0, 0.1), b.dir(0, 0, 1));
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Unterlagsboden',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
    });
    expect(facts.footprint.quality?.conditions).not.toContain('courtyard-ring');
  });
});
