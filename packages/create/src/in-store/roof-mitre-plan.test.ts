/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { planFootprintRoof } from './roof-footprint-plan.js';
import { planRoofMitres } from './roof-mitre-plan.js';

it.each([.001, 1, 1000])('the mitred ridge volume equals the independent section integral at scale %s (#9357)', scale => {
  const a = Math.PI/6, b = Math.PI/4, ta = Math.tan(a), tb = Math.tan(b), t = .25;
  const lower = 8*tb/(ta+tb), va = t/Math.cos(a), vb = t/Math.cos(b), upper = (8*tb+vb-va)/(ta+tb);
  // Integrate the two straight underside sections and the two offset top
  // sections independently. A vertical joint gives a different volume.
  const bottomArea = ta*lower**2/2 + tb*(8-lower)**2/2;
  const topArea = ta*upper**2/2 + va*upper + tb*(8-upper)**2/2 + vb*(8-upper);
  const roof = planFootprintRoof([[0,0],[10*scale,0],[10*scale,8*scale],[0,8*scale]], [a,0,b,0], 0);
  const planes = planRoofMitres(roof, t*scale);
  expect(planes).not.toBeNull();
  expect(planes!.reduce((volume, p) => volume+p.volume, 0)/scale**3).toBeCloseTo(10*(topArea-bottomArea), 8);
});
