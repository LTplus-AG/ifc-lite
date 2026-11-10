/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: rooms-with-area (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit Room, Archicad Zone, Bonsai space generation): two rooms bounded by walls are
// found, each room's area is the net floor area inside the wall faces (4.85 x 5.8 = 28.13 m²),
// the area is stored as Qto_SpaceBaseQuantities.NetFloorArea, and a room follows a moved
// bounding wall.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'rooms-with-area');
const S = bim.store, M = t.M, L1 = t.ground();
t.step('Level 2', () => S.addStorey(M, { Name: 'Level 2', Elevation: 3.0, referenceStoreyId: L1.expressId }));
const C = [[0, 0], [10, 0], [10, 6], [0, 6]];
const walls = C.map((c, i) => t.step(`wall ${i}`, () => S.addWall(M, L1.expressId, { Start: [...c, 0], End: [...C[(i + 1) % 4], 0], Thickness: 0.2, Height: 3 })));
for (let i = 0; i < 4; i++) t.step(`join ${i}`, () => S.joinWalls(M, walls[i].expressId, walls[(i + 1) % 4].expressId));
const part = t.step('partition', () => S.addWall(M, L1.expressId, { Start: [5, 0, 0], End: [5, 6, 0], Thickness: 0.1, Height: 3 }));
t.step('join partition S', () => S.joinWalls(M, part.expressId, walls[0].expressId));
t.step('join partition N', () => S.joinWalls(M, part.expressId, walls[2].expressId));
const gen = t.step('generate rooms', () => bim.spaces.generate({ storeys: [L1.expressId] }));
const spaces = () => bim.query().byType('IfcSpace').toArray();
const net = 4.85 * 5.8;
let x = await t.exportModel('rooms-generated');
const areas = (xm) => spaces().map((s) => { const b = xm.bbox(s.ref); return b ? xm.volume(s.ref) / b.size[2] : NaN; });
t.check('rooms bounded by walls are found', () => spaces().length === 2 || `found ${spaces().length} rooms (${JSON.stringify(gen)?.slice(0, 160)})`, { core: true });
t.check('room area is the net area inside the wall faces', () => (areas(x).length === 2 && areas(x).every((a) => P.near(a, net, 0.05))) || `room areas ${P.fmt(areas(x))} m² (the wall-centreline area), expected the net ${P.fmt(net)} m² inside the wall faces`, { core: true });
t.check('area is stored as NetFloorArea', () => {
  const q = [...x.content.matchAll(/IFCQUANTITYAREA\('NetFloorArea',[^,]*,[^,]*,([0-9.E+-]+)/g)].map((m) => Number(m[1]));
  return (q.length === 2 && q.every((a) => P.near(a, net, 0.05))) || `exported NetFloorArea ${q.length ? `${P.fmt(q)} m²` : 'missing'}, expected ${P.fmt(net)} m² per room`;
});
t.step('move partition 1 m east', () => S.transformElements(M, [part.expressId], { kind: 'move', delta: [1, 0] }));
x = await t.exportModel();
t.check('rooms follow a moved bounding wall', () => {
  const a = areas(x).sort((p, q) => p - q);
  return (P.near(a[0], 3.85 * 5.8, 0.05) && P.near(a[1], 5.85 * 5.8, 0.05)) || `after moving the partition 1 m the room areas are ${P.fmt(a)} m² (expected ${P.fmt([3.85 * 5.8, 5.85 * 5.8])})`;
});
t.done();
