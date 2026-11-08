// Modelling parity SDK probe: align-offset-trim-split (#9296). Run by ./run.mjs.
// Oracle (Revit Align/Offset/Trim-Extend/Split, Archicad Adjust/Offset/Trim/Split): align an
// element's edge to a reference, offset a wall to a parallel copy at a typed distance, extend
// a wall to a boundary wall, trim a wall at a crossing wall, and split a wall into two.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'align-offset-trim-split');
const S = bim.store, M = t.M, L1 = t.ground();
const w = (a, b, n) => t.step(n, () => S.addWall(M, L1.expressId, { Start: [...a, 0], End: [...b, 0], Thickness: 0.2, Height: 3, Name: n }));
const ref = t.step('reference column', () => S.addColumn(M, L1.expressId, { Position: [0, 0, 0], Width: 0.4, Depth: 0.4, Height: 3 }));
const mover = t.step('column to align', () => S.addColumn(M, L1.expressId, { Position: [3, 0.7, 0], Width: 0.4, Depth: 0.4, Height: 3 }));
const off = w([0, 12], [4, 12], 'offset source');
const ext = w([0, 20], [4, 20], 'to extend'), bnd = w([6, 18], [6, 22], 'boundary');
const trim = w([0, 30], [8, 30], 'to trim'), cut = w([5, 28], [5, 32], 'cutter');
const split = w([0, 40], [6, 40], 'to split');
await t.stepAsync('align bottom', () => S.alignElements(M, ref.expressId, [mover.expressId], 'bottom'));
const offs = t.step('offset 1.5 m', () => S.copyElements(M, [off.expressId], [{ offset: [0, 1.5, 0] }])) ?? [];
t.step('extend', () => S.trimExtendElement({ modelId: M, expressId: ext.expressId }, { mode: 'extend', click: [3.5, 20], boundary: { wallId: bnd.expressId } }));
t.step('trim', () => S.trimExtendElement({ modelId: M, expressId: trim.expressId }, { mode: 'trim', click: [7, 30], boundary: { wallId: cut.expressId } }));
const parts = t.step('split', () => S.splitElements(M, [{ expressId: split.expressId, cut: { kind: 'wall', distance: 2 } }])) ?? [];
const x = await t.exportModel();
t.check('align an edge to a reference', () => { const a = x.bbox(ref), b = x.bbox(mover); return (a && b && P.near(a.min[1], b.min[1], 2e-3) && P.near(b.centre[0], 3, 2e-3)) || `reference min y ${P.fmt(a?.min[1])}, aligned min y ${P.fmt(b?.min[1])}`; });
t.check('offset to a parallel copy at a typed distance', () => { const b = x.bbox(offs[0]); return (b && P.near(b.centre[1], 13.5, 2e-3) && P.near(b.size[0], 4, 0.25)) || `offset copy centre ${P.fmt(b?.centre)}`; });
t.check('extend to a boundary', () => { const b = x.bbox(ext); return (b && b.max[0] > 5.85 && b.max[0] < 6.15) || `extended wall ends at x ${P.fmt(b?.max[0])}, boundary at 6`; }, { core: true });
t.check('trim at a crossing element', () => { const b = x.bbox(trim); return (b && b.max[0] > 4.85 && b.max[0] < 5.15 && P.near(b.min[0], 0, 0.15)) || `trimmed wall spans x ${P.fmt(b?.min[0])}..${P.fmt(b?.max[0])}, cutter at 5`; }, { core: true });
t.check('split into two at a typed distance', () => {
  const p = parts[0];
  if (!p) return 'splitElements returned nothing';
  const lens = [p.left, p.right].map((r) => x.bbox(r)?.size[0]).sort((a, b) => a - b);
  return (P.near(lens[0], 2, 0.05) && P.near(lens[1], 4, 0.05)) || `split pieces ${P.fmt(lens)} m long`;
}, { core: true });
t.done();
