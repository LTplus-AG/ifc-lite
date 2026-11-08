// Modelling parity SDK probe: roof-by-footprint (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit Roof by Footprint, Archicad multi-plane roof, Bonsai roof by footprint): from a
// 10 x 8 m footprint with a slope per edge, a hip roof (30° on all four edges) rises 4·tan30 =
// 2.31 m to a 2 m ridge, a gable roof (30° on the long edges) has vertical gable ends, and a
// mono-pitch roof (10° on one edge) rises 8·tan10 = 1.41 m. The SDK's only live-model roof is
// addRoof; the probe asks it for each shape with a per-edge slope and measures what it built.
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
for (const [k, s] of Object.entries(shapes)) {
  t.check(`${k} roof by footprint`, () => {
    if (!roofs[k]) return 'addRoof refused the footprint';
    const b = x.bbox(roofs[k]);
    return (b && P.near(b.size[2] - 0.25, s.rise, 0.05)) || `addRoof built a flat ${P.fmt(b?.size[2])} m slab (rise ${P.fmt(Math.max(0, (b?.size[2] ?? 0.25) - 0.25))} m, expected ${P.fmt(s.rise)}): it has no slope per edge`;
  }, { core: k === 'hip' });
}
t.done();
