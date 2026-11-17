/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: large-tall-model-performance (#9296). Run by ./run.mjs.
// Oracle (issue #9296 R1, Revit/Archicad handle 40-storey towers interactively): the F5 tower
// (40 storeys, 7 x 7 grid, ~50-element typical floor copied to 39 storeys) authors headless in
// under 60 s, and the cost of one authoring operation grows less than 2x as the session grows.
// Both phases are capped so the probe stays bounded and reports how far it got.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'large-tall-model-performance');
const S = bim.store, M = t.M, L0 = t.ground();
const BUDGET_MS = 60000, SCALE_BUDGET_MS = 30000, F2F = 3.8, FLOORS = 40, TARGET_ELEMENTS = 1000;
// Phase A: per-operation cost as a fresh session grows, in its own process (batches of 50 columns).
const { execFileSync } = await import('node:child_process');
const helper = new URL('./perf-scale.js', process.env.PARITY_LIB).pathname;
const blank = process.argv[process.argv.length - 1];
const scaleOut = t.step('scale run', () => execFileSync(process.execPath, [process.argv[1], 'run', helper, blank], { encoding: 'utf8', env: { ...process.env, PARITY_SCALE_BUDGET_MS: String(SCALE_BUDGET_MS) }, maxBuffer: 1 << 24 }));
const batches = JSON.parse(scaleOut?.match(/@@SCALE@@(.*)/)?.[1] ?? '[]');
t.metrics.columnBatches = batches;
const first = batches[0], last = batches[batches.length - 1];
t.check('operation cost grows under 2x as the session grows', () => (last && last.sessionElements >= TARGET_ELEMENTS && last.msPerOp < 2 * first.msPerOp) || `one addColumn costs ${P.fmt(first?.msPerOp)} ms at ${first?.sessionElements} session elements and ${P.fmt(last?.msPerOp)} ms at ${last?.sessionElements} (${P.fmt(last?.msPerOp / first?.msPerOp)}x); the session reached ${last?.sessionElements ?? 0} of ${TARGET_ELEMENTS} elements in ${SCALE_BUDGET_MS / 1000} s`, { core: true });
// Phase B: the F5 tower against a 60 s budget.
const t0 = Date.now();
const left = () => BUDGET_MS - (Date.now() - t0);
let prev = L0.expressId;
const storeys = [];
for (let i = 1; i < FLOORS && left() > 0; i++) { const r = t.step(`storey ${i}`, () => S.addStorey(M, { Name: `L${String(i).padStart(2, '0')}`, Elevation: i * F2F, referenceStoreyId: prev })); if (r) { prev = r.expressId; storeys.push(r); } }
const xs = [0, 6, 12, 18, 24, 30, 36];
const grid = t.step('grid', () => S.addGrid(M, L0.expressId, { UAxes: xs.map((x, i) => ({ Tag: 'ABCDEFG'[i], Start: [x, -2], End: [x, 38] })), VAxes: xs.map((y, i) => ({ Tag: String(i + 1), Start: [-2, y], End: [38, y] })) }));
const axis = Object.fromEntries(bim.query().byType('IfcGridAxis').toArray().map((a) => [bim.attributes(a.ref).find((v) => v.name === 'AxisTag')?.value, a.ref.expressId]));
const typical = [];
const add = (label, fn) => { if (left() <= 0) return null; const r = t.step(label, fn); if (r) typical.push(r.expressId); return r; };
add('floor plate', () => S.addSlab(M, L0.expressId, { Profile: 'polygon', OuterCurve: [[-0.5, -0.5], [36.5, -0.5], [36.5, 36.5], [-0.5, 36.5]], Thickness: 0.3, ExtrudedDirection: [0, 0, -1] }));
for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
  if (xs[i] >= 12 && xs[i] <= 24 && xs[j] >= 12 && xs[j] <= 24) continue;
  add('column', () => S.addColumnOnGrid(M, L0.expressId, { Position: [xs[i], xs[j], 0], Width: 0.8, Depth: 0.8, Height: F2F - 0.3 }, { GridId: grid.expressId, IntersectingAxes: [axis['ABCDEFG'[i]], axis[String(j + 1)]] }));
}
const core = [[12, 12], [24, 12], [24, 24], [12, 24]];
for (let k = 0; k < 4; k++) add('core wall', () => S.addWall(M, L0.expressId, { Start: [...core[k], 0], End: [...core[(k + 1) % 4], 0], Thickness: 0.4, Height: F2F }));
const fac = [[[-0.6, -0.6], [36.6, -0.6]], [[36.6, -0.6], [36.6, 36.6]], [[36.6, 36.6], [-0.6, 36.6]], [[-0.6, 36.6], [-0.6, -0.6]]];
for (const [a, b] of fac) add('curtain wall', () => S.addCurtainWall(M, L0.expressId, { Start: [...a, 0], End: [...b, 0], Height: F2F - 0.3, UGrid: 25, VGrid: 2 }));
add('core stair', () => S.addStair(M, L0.expressId, { Position: [13, 13, 0], Direction: Math.PI / 2, NumberOfRisers: 22, RiserHeight: F2F / 22, TreadLength: 0.25, Width: 1.2 }));
const typicalMs = Date.now() - t0;
let copiedFloors = 0;
for (const s of storeys) { if (left() <= 0) break; if (t.step('copy floor', () => S.copyElements(M, typical, [{ targetStoreyId: s.expressId }]))) copiedFloors++; }
const towerMs = Date.now() - t0;
Object.assign(t.metrics, { storeys: storeys.length + 1, typicalElements: typical.length, typicalMs, copiedFloors, towerMs, elements: bim.query().toArray().length });
t.check('F5 tower authored headless in under 60 s', () => (storeys.length === FLOORS - 1 && copiedFloors === FLOORS - 1 && towerMs <= BUDGET_MS) || `after ${Math.round(towerMs / 1000)} s: ${storeys.length + 1}/${FLOORS} storeys, typical floor ${typical.length} elements in ${typicalMs} ms, ${copiedFloors}/${FLOORS - 1} floors copied`, { core: true });
// The tower is exported (not meshed) so the output level can validate it once performance passes.
await t.exportModel(t.capability, 'IFC4', { mesh: false });
t.done();
