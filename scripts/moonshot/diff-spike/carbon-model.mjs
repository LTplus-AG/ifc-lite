/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parametric building model for the M3 differentiability spike (bet B2.4).
 *
 * Design: a 3-storey rectangular building.
 *   - 4 exterior walls per storey (2 long at y=0/y=Ly full length Lx,
 *     2 short at x=0/x=Lx trimmed to length Ly - tw so corners touch
 *     without penetrating),
 *   - 1 interior partition per storey along Y at x = Lx/2 (length Ly - tw),
 *   - 1 floor slab per storey + 1 roof slab, both covering the outer
 *     footprint (Lx + tw) x (Ly + tw),
 *   - 4 columns per storey on a 1/3-2/3 grid, 2 beams per storey running
 *     along Y between the column faces on each column line,
 *   - 4 pad footings under the ground-storey columns,
 *   - windows: 3 per long facade per storey, 2 per short facade per
 *     storey; the ground-floor south facade swaps its centre window for
 *     an entrance door; each partition carries one door,
 *   - every window/door is a hosted fill: the wall gets a rectangular
 *     IfcOpeningElement cut (kernel CSG), the fill is its own solid.
 *
 * Element volumes are closed-form in the 24 design parameters, written
 * against the dual-number arithmetic in dual.mjs so a single evaluation
 * yields value + full analytic gradient. Opening subtraction uses exact
 * clipped overlap (min/max) so the formulas stay faithful to what the
 * kernel computes even when a window extends past the wall top.
 *
 * Units: metres, m2, m3, kgCO2e.
 */

import { add, sub, mul, div, min2, max2, relu, sum, scale, konst, value } from './dual.mjs';

/** Parameter spec: name, lower bound, upper bound. Order is the design vector. */
export const PARAMS = [
  { name: 'Lx', lo: 10, hi: 30, desc: 'footprint length along X' },
  { name: 'Ly', lo: 8, hi: 20, desc: 'footprint depth along Y' },
  { name: 'h1', lo: 3.0, hi: 4.5, desc: 'storey 1 floor-to-floor height' },
  { name: 'h2', lo: 3.0, hi: 4.5, desc: 'storey 2 floor-to-floor height' },
  { name: 'h3', lo: 3.0, hi: 4.5, desc: 'storey 3 floor-to-floor height' },
  { name: 'tw', lo: 0.18, hi: 0.5, desc: 'exterior wall thickness' },
  { name: 'ts', lo: 0.18, hi: 0.4, desc: 'floor slab thickness' },
  { name: 'tr', lo: 0.18, hi: 0.45, desc: 'roof slab thickness' },
  { name: 'wwL', lo: 0.6, hi: 2.2, desc: 'long-facade window width' },
  { name: 'wh', lo: 0.6, hi: 2.0, desc: 'window height (all windows)' },
  { name: 'sill', lo: 0.3, hi: 1.2, desc: 'window sill height above wall base' },
  { name: 'dw', lo: 0.9, hi: 1.6, desc: 'door width' },
  { name: 'dh', lo: 2.0, hi: 2.4, desc: 'door height' },
  { name: 'cw', lo: 0.2, hi: 0.6, desc: 'column width (X)' },
  { name: 'cd', lo: 0.2, hi: 0.6, desc: 'column depth (Y)' },
  { name: 'bw', lo: 0.15, hi: 0.4, desc: 'beam width' },
  { name: 'bh', lo: 0.25, hi: 0.6, desc: 'beam depth' },
  { name: 'tp', lo: 0.08, hi: 0.2, desc: 'partition wall thickness' },
  { name: 'wwS', lo: 0.6, hi: 2.2, desc: 'short-facade window width' },
  { name: 'gt', lo: 0.02, hi: 0.06, desc: 'window glazing thickness' },
  { name: 'fw', lo: 0.6, hi: 1.6, desc: 'footing width (X)' },
  { name: 'fd', lo: 0.6, hi: 1.6, desc: 'footing depth (Y)' },
  { name: 'fh', lo: 0.5, hi: 1.2, desc: 'footing height' },
  { name: 'dt', lo: 0.04, hi: 0.06, desc: 'door leaf thickness' },
];

export const NPARAMS = PARAMS.length; // 24

/**
 * Embodied-carbon factors, kgCO2e per m3 of installed material.
 * Illustrative cradle-to-gate values, fixed for the whole spike; the
 * spike's claim is about gradients, not about the factors themselves.
 */
export const CARBON_FACTORS = {
  Concrete: 315,
  Brick: 250,
  Gypsum: 120,
  Glass: 3300,
  Timber: 130,
};

const NSTOREYS = 3;
/** Windows per storey per facade. */
export const WINDOWS_LONG = 3; // each of the 2 long facades
export const WINDOWS_SHORT = 2; // each of the 2 short facades
/** Beam end gap to the column face, metres (fixed constant). */
const BEAM_GAP = 0.05;
/**
 * Fill inset, metres: window/door panels are 2 mm smaller than their
 * opening on each inset side (a stand-in for the frame gap), so fills
 * never share a surface with their host wall. The wall subtraction uses
 * the FULL opening size; only the fill element volume uses the inset.
 */
export const FILL_INSET = 0.002;

/**
 * Window centre positions along a wall of length L (as fractions of L).
 * Fixed fractions keep counts/topology constant across the whole
 * parameter box, so the only non-smoothness is the opening clip.
 */
export function windowFractions(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push((i + 0.5) / count);
  return out;
}

/**
 * Net volume of one wall of gross length L, thickness t, height H with a
 * list of rectangular openings { w, h, sill }. Openings are clipped
 * vertically against the wall height exactly like the kernel's CSG cut:
 * cut volume = w * (min(sill + h, H) - sill) * t, never negative.
 * Horizontal clipping is not modelled because the layout guarantees
 * openings stay inside the wall span for the whole parameter box.
 */
function wallNetVolume(L, t, H, openings) {
  let vol = mul(mul(L, t), H);
  for (const o of openings) {
    const top = min2(add(o.sill, o.h), H);
    const cutH = relu(sub(top, o.sill));
    vol = sub(vol, mul(mul(o.w, cutH), t));
  }
  return vol;
}

/**
 * Evaluate the full parametric building.
 *
 * @param {Array<Dual|number>} p design vector in PARAMS order
 * @returns {{ elements: Array<{key: string, ifcType: string, material: string, volume: Dual|number}>,
 *            carbon: Dual|number,
 *            totalVolume: Dual|number,
 *            byMaterial: Record<string, Dual|number>,
 *            derived: object }}
 */
export function evaluateModel(p) {
  const [Lx, Ly, h1, h2, h3, tw, ts, tr, wwL, wh, sill, dw, dh,
    cw, cd, bw, bh, tp, wwS, gt, fw, fd, fh, dt] = p;

  const storeyHeights = [h1, h2, h3];
  const elements = [];
  const pushEl = (key, ifcType, material, volume) => {
    elements.push({ key, ifcType, material, volume });
  };

  for (let s = 0; s < NSTOREYS; s++) {
    const h = storeyHeights[s];
    /** Clear wall height: walls sit on the storey slab and run to the
     * underside of the next slab (= storey top). */
    const H = sub(h, ts);

    // Long facades (y = 0 south, y = Ly north), gross length Lx.
    for (const side of ['south', 'north']) {
      const openings = [];
      const isEntrance = s === 0 && side === 'south';
      const fracs = windowFractions(WINDOWS_LONG);
      for (let i = 0; i < fracs.length; i++) {
        if (isEntrance && i === 1) {
          // centre window replaced by the entrance door
          openings.push({ w: dw, h: dh, sill: konst(0), kind: 'door' });
        } else {
          openings.push({ w: wwL, h: wh, sill, kind: 'window' });
        }
      }
      pushEl(`wall-${side}-s${s}`, 'IfcWall', 'Brick', wallNetVolume(Lx, tw, H, openings));
      for (let i = 0; i < openings.length; i++) {
        const o = openings[i];
        if (o.kind === 'door') {
          // Door leaf: inset on sides and top, flush at the floor.
          pushEl(`door-entrance`, 'IfcDoor', 'Timber',
            mul(mul(sub(dw, 2 * FILL_INSET), sub(dh, FILL_INSET)), dt));
        } else {
          pushEl(`win-${side}-s${s}-${i}`, 'IfcWindow', 'Glass',
            mul(mul(sub(o.w, 2 * FILL_INSET), sub(o.h, 2 * FILL_INSET)), gt));
        }
      }
    }

    // Short facades (x = 0 west, x = Lx east), trimmed length Ly - tw.
    const shortLen = sub(Ly, tw);
    for (const side of ['west', 'east']) {
      const openings = [];
      for (let i = 0; i < WINDOWS_SHORT; i++) {
        openings.push({ w: wwS, h: wh, sill });
      }
      pushEl(`wall-${side}-s${s}`, 'IfcWall', 'Brick', wallNetVolume(shortLen, tw, H, openings));
      for (let i = 0; i < WINDOWS_SHORT; i++) {
        pushEl(`win-${side}-s${s}-${i}`, 'IfcWindow', 'Glass',
          mul(mul(sub(wwS, 2 * FILL_INSET), sub(wh, 2 * FILL_INSET)), gt));
      }
    }

    // Interior partition along Y at x = Lx/2, one door at its centre.
    const partOpenings = [{ w: dw, h: dh, sill: konst(0) }];
    pushEl(`partition-s${s}`, 'IfcWall', 'Gypsum', wallNetVolume(shortLen, tp, H, partOpenings));
    pushEl(`door-part-s${s}`, 'IfcDoor', 'Timber',
      mul(mul(sub(dw, 2 * FILL_INSET), sub(dh, FILL_INSET)), dt));

    // Floor slab over the outer footprint.
    const slabW = add(Lx, tw);
    const slabD = add(Ly, tw);
    pushEl(`slab-s${s}`, 'IfcSlab', 'Concrete', mul(mul(slabW, slabD), ts));

    // Columns: 4 on the (1/3, 2/3) grid, clear height H.
    for (let i = 0; i < 4; i++) {
      pushEl(`col-s${s}-${i}`, 'IfcColumn', 'Concrete', mul(mul(cw, cd), H));
    }

    // Beams: 2 per storey along Y between column faces.
    // Span = (2/3 - 1/3) * Ly - cd - 2 * gap.
    const beamLen = sub(sub(div(Ly, 3), cd), 2 * BEAM_GAP);
    for (let i = 0; i < 2; i++) {
      pushEl(`beam-s${s}-${i}`, 'IfcBeam', 'Concrete', mul(mul(bw, bh), beamLen));
    }
  }

  // Roof slab over the outer footprint.
  pushEl('roof', 'IfcRoof', 'Concrete', mul(mul(add(Lx, tw), add(Ly, tw)), tr));

  // Footings under ground-storey columns.
  for (let i = 0; i < 4; i++) {
    pushEl(`footing-${i}`, 'IfcFooting', 'Concrete', mul(mul(fw, fd), fh));
  }

  // Totals.
  const byMaterial = {};
  for (const mat of Object.keys(CARBON_FACTORS)) byMaterial[mat] = konst(0);
  for (const el of elements) {
    byMaterial[el.material] = add(byMaterial[el.material], el.volume);
  }
  let carbon = konst(0);
  for (const [mat, vol] of Object.entries(byMaterial)) {
    carbon = add(carbon, scale(vol, CARBON_FACTORS[mat]));
  }
  const totalVolume = sum(elements.map((e) => e.volume));

  // Derived quantities used by the optimization constraints.
  const innerW = sub(Lx, tw);
  const innerD = sub(Ly, tw);
  const floorAreaPerStorey = mul(innerW, innerD);
  const floorAreaTotal = scale(floorAreaPerStorey, NSTOREYS);
  // Window area per storey: ground storey loses one long-facade window
  // to the entrance door.
  const winAreaLong = mul(wwL, wh);
  const winAreaShort = mul(wwS, wh);
  const windowAreas = storeyHeights.map((_, s) => {
    const nLong = 2 * WINDOWS_LONG - (s === 0 ? 1 : 0);
    const nShort = 2 * WINDOWS_SHORT;
    return add(scale(winAreaLong, nLong), scale(winAreaShort, nShort));
  });

  return {
    elements,
    carbon,
    totalVolume,
    byMaterial,
    derived: { floorAreaPerStorey, floorAreaTotal, windowAreas, storeyHeights },
  };
}

/**
 * Optimization constraints, all expressed as g(x) <= 0.
 * Returns an array of { name, g } with g a Dual|number.
 */
export function constraints(p, model) {
  const [Lx, Ly, , , , tw, ts, tr, , wh, sill, dw, , cw, cd, , bh] = p;
  const { storeyHeights, floorAreaTotal, floorAreaPerStorey, windowAreas } = model.derived;
  const gs = [];

  // Headroom: clear height per storey >= 2.5 m.
  for (let s = 0; s < NSTOREYS; s++) {
    gs.push({ name: `headroom-s${s}`, g: sub(2.5, sub(storeyHeights[s], ts)) });
  }
  // Programme: total floor area >= 600 m2.
  gs.push({ name: 'floor-area', g: sub(600, floorAreaTotal) });
  // Daylight: window area per storey >= 12% of that storey's floor area.
  for (let s = 0; s < NSTOREYS; s++) {
    gs.push({ name: `daylight-s${s}`, g: sub(scale(floorAreaPerStorey, 0.12), windowAreas[s]) });
  }
  // Window fit: sill + window height + 0.1 <= clear wall height.
  for (let s = 0; s < NSTOREYS; s++) {
    gs.push({
      name: `window-fit-s${s}`,
      g: sub(add(add(sill, wh), 0.1), sub(storeyHeights[s], ts)),
    });
  }
  // Structural proxy: column section carries 3 storeys of tributary area.
  // cw * cd >= 0.0012 * (Lx * Ly / 9) * 3.
  gs.push({ name: 'column-section', g: sub(scale(mul(Lx, div(Ly, 9)), 0.0012 * 3), mul(cw, cd)) });
  // Beam depth >= clear Y span / 12.
  gs.push({ name: 'beam-depth', g: sub(div(Ly, 3 * 12), bh) });
  // Slab and roof thickness >= max span between column lines / 32 (resp. /30).
  const span = div(max2(Lx, Ly), 3);
  gs.push({ name: 'slab-span', g: sub(div(span, 32), ts) });
  gs.push({ name: 'roof-span', g: sub(div(span, 30), tr) });
  // Egress: door clear width >= 0.95.
  gs.push({ name: 'egress', g: sub(0.95, dw) });
  return gs;
}

/** Evaluate model + constraints on plain numbers (no gradients). */
export function evaluateNumeric(x) {
  const model = evaluateModel(Array.from(x));
  const gs = constraints(Array.from(x), model);
  return {
    carbon: value(model.carbon),
    totalVolume: value(model.totalVolume),
    constraints: gs.map((c) => ({ name: c.name, g: value(c.g) })),
    model,
  };
}
