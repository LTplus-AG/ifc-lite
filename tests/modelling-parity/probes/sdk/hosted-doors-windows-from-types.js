/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: hosted-doors-windows-from-types (#9296). Run by ./run.mjs.
// Oracle (Revit hosted families, Archicad door/window objects): a door and a window placed
// from their types cut real openings in the wall, are typed occurrences, move with their host
// and slide along it when edited.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'hosted-doors-windows-from-types');
const S = bim.store, M = t.M, L1 = t.ground();
const wall = t.step('wall', () => S.addWall(M, L1.expressId, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3, Name: 'Host' }));
const dType = t.step('door type', () => S.addElementType(M, { Type: 'IfcDoorType', Name: 'D 90x210', PredefinedType: 'DOOR', OperationType: 'SINGLE_SWING_LEFT' }));
const wType = t.step('window type', () => S.addElementType(M, { Type: 'IfcWindowType', Name: 'W 120x140', PredefinedType: 'WINDOW', PartitioningType: 'SINGLE_PANEL' }));
const door = t.step('door', () => S.addHostedDoor(M, wall.expressId, { Offset: 2, Width: 0.9, Height: 2.1 }));
const win = t.step('window', () => S.addHostedWindow(M, wall.expressId, { Offset: 4.5, Sill: 0.9, Width: 1.2, Height: 1.4 }));
t.step('type door', () => S.assignType(M, dType.expressId, [door.expressId]));
t.step('type window', () => S.assignType(M, wType.expressId, [win.expressId]));
let x = await t.exportModel('hosted-placed');
t.check('door and window cut real openings', () => {
  const d = x.contains(wall, [2, 0, 1]), above = x.contains(wall, [2, 0, 2.6]), w = x.contains(wall, [4.5, 0, 1.6]), sill = x.contains(wall, [4.5, 0, 0.5]);
  return (!d && above && !w && sill && x.count('IFCRELFILLSELEMENT') === 2) || `solid at door ${d}, above door ${above}, at window ${w}, below sill ${sill}; fills ${x.count('IFCRELFILLSELEMENT')}`;
}, { core: true });
t.check('door and window are typed occurrences', () => {
  const rels = x.content.match(/IFCRELDEFINESBYTYPE\([^;]*;/g) ?? [];
  const d = x.exportedId(door), w = x.exportedId(win);
  return (rels.some((r) => r.includes(`#${d}`)) && rels.some((r) => r.includes(`#${w}`))) || `IfcRelDefinesByType rows: ${rels.length}`;
});
t.step('move host 1 m north', () => S.transformElements(M, [wall.expressId], { kind: 'move', delta: [0, 1] }));
x = await t.exportModel('hosted-moved');
t.check('openings and fillings move with the host', () => {
  const b = x.bbox(door), hole = !x.contains(wall, [2, 1, 1]);
  return (b && P.near(b.centre[1], 1, 0.05) && hole) || `door centre y ${P.fmt(b?.centre[1])} (expected 1), hole at the moved door ${hole}`;
});
t.step('slide door', () => S.editHostedElement({ modelId: M, expressId: door.expressId }, { Offset: 3 }));
x = await t.exportModel();
t.check('a door slides along its host', () => {
  const now = !x.contains(wall, [3, 1, 1]), before = x.contains(wall, [1.6, 1, 1]);
  return (now && before) || `void at the new offset ${now}, wall closed at the old offset ${before}`;
});
t.done();
