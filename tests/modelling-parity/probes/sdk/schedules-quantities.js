/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: schedules-quantities (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit/Archicad schedules, Bonsai/IfcOpenShell base quantities): a wall schedule lists
// every wall, its Length and NetVolume match the modelled geometry (door opening deducted) within
// 1 %, and a door schedule lists the door's width. Schedules come from `ifc-lite schedule` on
// the exported file, the headless schedule surface.
const P = await import(process.env.PARITY_LIB);
const { execFileSync } = await import('node:child_process');
const t = P.probe(bim, 'schedules-quantities');
const S = bim.store, M = t.M, L1 = t.ground();
const C = [[0, 0], [10, 0], [10, 8], [0, 8]];
const walls = C.map((c, i) => t.step(`wall ${i}`, () => S.addWall(M, L1.expressId, { Start: [...c, 0], End: [...C[(i + 1) % 4], 0], Thickness: 0.25, Height: 3, Name: `W${i}` })));
for (let i = 0; i < 4; i++) t.step(`join ${i}`, () => S.joinWalls(M, walls[i].expressId, walls[(i + 1) % 4].expressId));
t.step('door', () => S.addHostedDoor(M, walls[0].expressId, { Offset: 5, Width: 0.9, Height: 2.1, Name: 'D1' }));
const x = await t.exportModel();
const file = `${process.env.PARITY_ROOT}/${x.path}`;
const schedule = (preset) => JSON.parse(execFileSync(process.execPath, [process.argv[1], 'schedule', file, '--preset', preset, '--format', 'json'], { encoding: 'utf8' }));
const wallRows = t.step('wall schedule', () => schedule('wall')) ?? [];
const rows = Array.isArray(wallRows) ? wallRows : wallRows.rows ?? [];
t.metrics.wallRows = rows.length;
t.check('a wall schedule lists every wall', () => (rows.length === 4 && ['W0', 'W1', 'W2', 'W3'].every((n) => rows.some((r) => r.Name === n))) || `wall schedule rows: ${JSON.stringify(rows).slice(0, 200)}`);
t.check('wall quantities match the geometry', () => {
  const bad = walls.map((w, i) => {
    const r = rows.find((row) => row.Name === `W${i}`) ?? {};
    const v = x.volume(w), len = Number(r.Length), nv = Number(r.NetVolume);
    return Number.isFinite(nv) && Math.abs(nv - v) / v < 0.01 && Number.isFinite(len) && len >= (i % 2 ? 8 : 10) - 0.3 ? null : `W${i} Length=${r.Length ?? '∅'} NetVolume=${r.NetVolume ?? '∅'} (mesh ${P.fmt(v)} m³)`;
  }).filter(Boolean);
  return bad.length === 0 || bad.join('; ');
}, { core: true });
const doorRows = t.step('door schedule', () => schedule('door')) ?? [];
const drows = Array.isArray(doorRows) ? doorRows : doorRows.rows ?? [];
t.check('a door schedule lists the door width', () => (drows.length === 1 && P.near(Number(drows[0].Width), 0.9, 1e-3)) || `door schedule rows: ${JSON.stringify(drows).slice(0, 200)}`);
t.done();
