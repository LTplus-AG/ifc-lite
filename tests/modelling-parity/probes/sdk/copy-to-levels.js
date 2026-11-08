// Modelling parity SDK probe: copy-to-levels (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit Paste Aligned to Selected Levels, Archicad copy to storeys): a typical floor
// (walls attached to the storey above, a hosted door, a slab, a column) copies to several
// storeys in one operation, lands on each, keeps its door hosted, and the copied walls attach to
// the storey above their NEW storey so they follow later level edits.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'copy-to-levels');
const S = bim.store, M = t.M, L1 = t.ground();
const names = ['Level 2', 'Level 3', 'Level 4'];
let prev = L1.expressId;
const lv = names.map((Name, i) => { const r = t.step(Name, () => S.addStorey(M, { Name, Elevation: 3 * (i + 1), referenceStoreyId: prev })); prev = r?.expressId ?? prev; return r; });
const level = (i) => t.levels().find((s) => s.expressId === lv[i]?.expressId);
const C = [[0, 0], [8, 0], [8, 6], [0, 6]];
const walls = C.map((c, i) => t.step(`wall ${i}`, () => S.addWall(M, L1.expressId, { Start: [...c, 0], End: [...C[(i + 1) % 4], 0], Thickness: 0.2, Height: 3, Name: `W${i}` })));
for (const w of walls) t.step('attach', () => bim.mutate.setProperty(w, 'IfcLite_StoreyAttachment', 'TopConstraint', t.globalId(lv[0]), 'IfcLabel'));
t.step('door', () => S.addHostedDoor(M, walls[0].expressId, { Offset: 4, Width: 0.9, Height: 2.1 }));
const slab = t.step('slab', () => S.addSlab(M, L1.expressId, { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: 0.2, ExtrudedDirection: [0, 0, -1] }));
const col = t.step('column', () => S.addColumn(M, L1.expressId, { Position: [4, 3, 0], Width: 0.3, Depth: 0.3, Height: 3 }));
const ids = [...walls, slab, col].filter(Boolean).map((r) => r.expressId);
const t0 = Date.now();
const copies = t.step('copy to Level 2 and Level 3', () => S.copyElements(M, ids, [lv[0], lv[1]].map((s) => ({ targetStoreyId: s.expressId })))) ?? [];
t.metrics.copyMs = Date.now() - t0;
t.metrics.copied = copies.length;
const on = (s) => bim.contains({ modelId: M, expressId: s.expressId }).filter((e) => /Wall|Slab|Column|Door/.test(e.type));
t.check('one operation copies the floor onto each storey', () => {
  const a = on(lv[0]), b = on(lv[1]);
  const kinds = (es) => es.map((e) => e.type.replace('StandardCase', '')).sort().join(',');
  return (kinds(a) === kinds(on(L1)) && kinds(b) === kinds(on(L1))) || `Level 1: ${kinds(on(L1))}; Level 2: ${kinds(a)}; Level 3: ${kinds(b)}`;
}, { core: true });
const x = await t.exportModel();
const copiedWalls = (s) => on(s).filter((e) => /Wall/.test(e.type)).map((e) => e.ref);
t.check('copies land at their storey elevation with the door hosted', () => {
  // The copied host wall runs along y = 0: void at the door (x 4), solid beside it (x 1).
  const host = (s) => copiedWalls(s).find((w) => { const b = x.bbox(w); return b && P.near(b.centre[1], 0, 0.05) && b.size[0] > 7; });
  const hosted = (s) => { const h = host(s); return h && !x.contains(h, [4, 0, s.elevation + 1]) && x.contains(h, [1, 0, s.elevation + 1]); };
  const ok = [level(0), level(1)].every((s) => copiedWalls(s).every((w) => P.near(x.bbox(w)?.min[2], s.elevation, 2e-3)) && hosted(s));
  return ok || `copied wall bases ${[level(0), level(1)].map((s) => copiedWalls(s).map((w) => P.fmt(x.bbox(w)?.min[2])).join('/')).join(' | ')}`;
});
t.check('copied walls attach to the storey above their new storey', () => {
  const tops = [[level(0), level(1)], [level(1), level(2)]].map(([s, above]) => copiedWalls(s).map((w) => [bim.property(w, 'IfcLite_StoreyAttachment', 'TopConstraint'), above.GlobalId, x.bbox(w)?.max[2], above.elevation]));
  const ok = tops.every((rows) => rows.length && rows.every(([g, want, z, e]) => g === want && P.near(z, e, 2e-3)));
  return ok || `copied walls keep TopConstraint ${tops.map((rows) => rows.map(([g, want]) => (g === want ? 'rebound' : g === level(0).GlobalId ? 'Level 2 (copied verbatim)' : g)).join('/')).join(' | ')}`;
});
t.done();
