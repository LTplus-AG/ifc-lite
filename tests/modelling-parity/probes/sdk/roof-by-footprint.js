/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: roof-by-footprint (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit Roof by Footprint, Archicad multi-plane roof, Bonsai roof by footprint): from a
// 10 x 8 m footprint with a slope per edge, a hip roof (30° on all four edges) rises 4·tan30 =
// 2.31 m to a 2 m ridge, a gable roof (30° on the long edges) has vertical gable ends, and a
// mono-pitch roof (10° on one edge) rises 8·tan10 = 1.41 m. The SDK's only live-model roof is
// addRoof; the probe asks it for each shape with a per-edge slope and judges the meshed roof's
// sloped surface, corners, centre and volume (lib/roof-oracle.mjs), so a prism of the right
// height does not pass.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'roof-by-footprint');
const S = bim.store, M = t.M, L1 = t.ground();
const D = Math.PI / 180, footprint = [[0, 0], [10, 0], [10, 8], [0, 8]];
const shapes = {
  hip: { slopes: [30, 30, 30, 30], rise: 4 * Math.tan(30 * D) },
  gable: { slopes: [30, 0, 30, 0], rise: 4 * Math.tan(30 * D) },
  mono: { slopes: [10, 0, 0, 0], rise: 8 * Math.tan(10 * D) },
};
const roofs = {};
for (const [k, s] of Object.entries(shapes)) {
  roofs[k] = t.step(`${k} roof`, () => S.addRoof(M, L1.expressId, {
    Profile: 'polygon', OuterCurve: footprint, Thickness: 0.25, Name: `${k} roof`,
    // Per-edge slopes as Revit/Archicad take them; a footprint roof API would read these.
    Slopes: s.slopes.map((a) => a * D), EdgeSlopes: s.slopes.map((a) => a * D),
  }));
}
const x = await t.exportModel();
// The surface, eave-to-ridge, corner/centre and volume oracle lives in lib/roof-oracle.mjs so it is
// unit-tested against a flat slab, a full-height prism (both must fail) and a real sloped plate.
const { judgeRoof } = await import(new URL('./roof-oracle.mjs', process.env.PARITY_LIB).href);
for (const [k, s] of Object.entries(shapes)) {
  t.check(`${k} roof by footprint`, () => {
    if (!roofs[k]) return 'addRoof refused the footprint';
    const b = x.bbox(roofs[k]);
    const verdict = judgeRoof(x.parts(roofs[k]), { footprint, slopes: s.slopes.map((a) => a * D), thickness: 0.25, hip: k === 'hip' });
    if (verdict === true) return true;
    const flat = b && P.near(b.size[2], 0.25, 0.01);
    return flat ? `addRoof built a flat ${P.fmt(b.size[2])} m slab (expected a ${P.fmt(s.rise)} m rise from per-edge slopes): ${verdict}` : verdict;
  }, { core: k === 'hip' });
}
t.done();
