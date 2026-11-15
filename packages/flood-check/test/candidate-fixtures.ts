/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Synthetic elements that take the exits of candidate selection and the readability cases of `locate.ts`. */

import { readFileSync } from 'node:fs';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { MapPoint } from '../src/types.js';
import { syntheticRaster } from './helpers.js';
import { mapOf, ORIGIN, ROTATION_DEG, type Extra } from './synthetic-model.js';

export function localOf(p: MapPoint): MapPoint {
  const a = (ROTATION_DEG * Math.PI) / 180;
  const dx = p.x - ORIGIN.e;
  const dy = p.y - ORIGIN.n;
  return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
}

export function raster(paint: (local: MapPoint) => number) {
  const c = [mapOf(-10, -10), mapOf(40, -10), mapOf(-10, 25), mapOf(40, 25)];
  const x0 = Math.floor(Math.min(...c.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...c.map((p) => p.y)));
  return syntheticRaster(x0, y0, 120, 120, 0.5, (p) => paint(localOf(p)));
}

/** An external wall along the east face (x = 20) of the house. */
export function eastWall(b: Extra): number {
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
  b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  b.contain(b.storeys.eg.id, wall);
  return wall;
}

/** A door placed at the south wall's origin while its opening's body puts the hole 15 m along the façade. */
export function doorAtWallOrigin(b: Extra) {
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Süd 2',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},$,$,.STANDARD.)`);
  b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  const hole = b.rectExtrusion(0, 0, 1, 2.1, 0.4, b.axis(15, -0.2, 1.05, b.dir(0, 1, 0), b.dir(1, 0, 0)), b.dir(0, 0, 1));
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Tor',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'Tor',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},$,$,2.1,1.,.DOOR.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
  b.contain(b.storeys.eg.id, wall);
  b.contain(b.storeys.eg.id, door);
}

/** A window in the east wall whose opening has a readable upper part (z 2..3) and an unreadable lower item. */
export function windowWithPartlyReadableOpening(b: Extra) {
  const wall = eastWall(b);
  const upper = b.rectExtrusion(0, 0, 1, 1, 0.4, b.axis(-0.2, 5, 2.5, b.dir(1, 0, 0), b.dir(0, 1, 0)), b.dir(0, 0, 1));
  const lower = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Fenster Brep',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([upper, lower])},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster Brep',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 2.5)},$,$,1.,1.,.WINDOW.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
  b.contain(b.storeys.eg.id, win);
}

/** A ramp placed 0.5 m inside the east face, no IsExternal, its body descending outside (x 20.5..23.5, z -1.5..0). */
export function rampPlacedInside(b: Extra) {
  const body = b.rectExtrusion(3.5, 0, 3, 2, 1.5, b.axis(0, 0, -1.5), b.dir(0, 0, 1));
  const ramp = b.add(`IFCRAMP(${b.guid()},$,'Rampe Garage',$,$,#${b.place(b.storeys.eg.pl, 19.5, 5, 0)},#${b.shape([body])},$,.STRAIGHT_RUN_RAMP.)`);
  b.contain(b.storeys.eg.id, ramp);
}

/** An unplaceable door filling an opening whose body puts the hole at x 7..8 in an external south wall. */
export function unplacedDoorInPlacedOpening(b: Extra) {
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Süd 3',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},$,$,.STANDARD.)`);
  b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  const hole = b.rectExtrusion(0, 0, 1, 2.1, 0.4, b.axis(7.5, -0.2, 1.05, b.dir(0, 1, 0), b.dir(1, 0, 0)), b.dir(0, 0, 1));
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Tür lose',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'Tür lose',$,$,$,$,$,2.1,1.,.DOOR.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
  b.contain(b.storeys.eg.id, wall);
  b.contain(b.storeys.eg.id, door);
}

/** An unplaceable external stair whose flight is placed outside the house and descends 2 m. */
export function flightOfUnplacedStair(b: Extra) {
  const body = b.rectExtrusion(0, 0, 2, 3, 2, b.axis(0, 0, -2), b.dir(0, 0, 1));
  const flight = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf Kellerabgang',$,$,#${b.place(b.storeys.eg.pl, 5, -3, 0)},#${b.shape([body])},$,$,$,$,$,.STRAIGHT.)`);
  const stair = b.add(`IFCSTAIR(${b.guid()},$,'Kellerabgang lose',$,$,$,$,$,.STRAIGHT_RUN_STAIR.)`);
  b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${stair},(#${flight}))`);
  b.contain(b.storeys.eg.id, stair);
}

/** Extra elements that each take a different exit of candidate selection. */
export function zooForFixtures(b: Extra) {
  doorAtWallOrigin(b);
  unplacedDoorInPlacedOpening(b);
  flightOfUnplacedStair(b);
  windowWithPartlyReadableOpening(b);
  rampPlacedInside(b);
  const { eg, og, ug } = b.storeys;
  // Interior door, no pset, deep inside; and one explicitly not external.
  b.contain(eg.id, b.add(`IFCDOOR(${b.guid()},$,'Innentür',$,$,#${b.place(eg.pl, 10, 5, 0)},#${b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,2.1,1.,.DOOR.,$,$)`));
  const notExt = b.add(`IFCDOOR(${b.guid()},$,'Zimmertür',$,$,#${b.place(eg.pl, 8, 5, 0)},$,$,2.1,1.,.DOOR.,$,$)`);
  b.pset(notExt, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
  b.contain(eg.id, notExt);
  // A door with no placement.
  b.contain(eg.id, b.add(`IFCDOOR(${b.guid()},$,'Tür ohne Platz',$,$,$,$,$,2.1,1.,.DOOR.,$,$)`));
  // An upper-floor window (out of scope).
  const up = b.add(`IFCWINDOW(${b.guid()},$,'Fenster OG',$,$,#${b.place(og.pl, 5, 0, 1)},$,$,1.,1.,.WINDOW.,$,$)`);
  b.pset(up, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  b.contain(og.id, up);
  // A stair with two flights, and an interior stair with a readable body inside.
  const flight1 = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf 1',$,$,#${b.place(eg.pl, 30, 5, 0)},$,$,$,$,$,$,.STRAIGHT.)`);
  const flight2 = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf 2',$,$,#${b.place(eg.pl, 30, 7, 0)},$,$,$,$,$,$,.STRAIGHT.)`);
  const stair = b.add(`IFCSTAIR(${b.guid()},$,'Treppe mit Läufen',$,$,#${b.place(eg.pl, 30, 5, 0)},$,$,.STRAIGHT_RUN_STAIR.)`);
  b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${stair},(#${flight1},#${flight2}))`);
  b.contain(eg.id, stair);
  const inner = b.rectExtrusion(0, 0, 2, 2, 3, b.axis(0, 0, 0), b.dir(0, 0, 1));
  b.contain(eg.id, b.add(`IFCSTAIR(${b.guid()},$,'Innentreppe EG',$,$,#${b.place(eg.pl, 10, 5, 0)},#${b.shape([inner])},$,.STRAIGHT_RUN_STAIR.)`));
  // An opening filled by a proxy (a gate modelled as a proxy), a RECESS, and one with no host.
  const wall = eastWall(b);
  const gateHole = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Tor Proxy',$,$,#${b.place(eg.pl, 20, 8, 0)},$,$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${gateHole})`);
  const gate = b.add(`IFCBUILDINGELEMENTPROXY(${b.guid()},$,'Tor Proxy',$,$,#${b.place(eg.pl, 20, 8, 0)},$,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${gateHole},#${gate})`);
  const recess = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Nische',$,$,#${b.place(eg.pl, 20, 2, 0)},$,$,.RECESS.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${recess})`);
  b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Loses Loch',$,$,#${b.place(eg.pl, 20, 3, 0.5)},$,$,.OPENING.)`);
  // A light well above the scope, an elevator with no stated kind, an escalator, and upper-floor equipment.
  b.contain(og.id, b.add(`IFCBUILDINGELEMENTPROXY(${b.guid()},$,'Lichtschacht hoch',$,$,#${b.place(og.pl, 5, -1, 3)},$,$,$)`));
  b.contain(ug.id, b.add(`IFCTRANSPORTELEMENT(${b.guid()},$,'Aufzug',$,$,#${b.place(ug.pl, 15, 5, 0)},$,$,.NOTDEFINED.)`));
  b.contain(eg.id, b.add(`IFCTRANSPORTELEMENT(${b.guid()},$,'Rolltreppe',$,$,#${b.place(eg.pl, 15, 5, 0)},$,$,.ESCALATOR.)`));
  b.contain(og.id, b.add(`IFCBOILER(${b.guid()},$,'Kessel OG',$,$,#${b.place(og.pl, 3, 3, 0)},$,$,.WATER.)`));
}

/** A second building, 20 m east, with a door, a basement window and a boiler. */
export function secondBuilding(b: Extra) {
  const pl = b.place(b.site.pl, 40, 0, 0);
  const bld = b.add(`IFCBUILDING(${b.guid()},$,'Nebengebäude',$,$,#${pl},$,$,.ELEMENT.,$,$,$)`);
  b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${b.site.id},(#${bld}))`);
  const egPl = b.place(pl, 0, 0, 0);
  const eg = b.add(`IFCBUILDINGSTOREY(${b.guid()},$,'B EG',$,$,#${egPl},$,$,.ELEMENT.,0.)`);
  b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${bld},(#${eg}))`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'B Tür',$,$,#${b.place(egPl, 10, 0, 0)},$,$,2.1,1.,.DOOR.,$,$)`);
  b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  const boiler = b.add(`IFCBOILER(${b.guid()},$,'B Kessel',$,$,#${b.place(egPl, 10, 5, 0)},$,$,.WATER.)`);
  b.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${b.guid()},$,$,$,(#${door},#${boiler}),#${eg})`);
}

export async function parseFile(path: string): Promise<IfcDataStore> {
  const b = readFileSync(path);
  return new IfcParser().parseColumnar(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}
