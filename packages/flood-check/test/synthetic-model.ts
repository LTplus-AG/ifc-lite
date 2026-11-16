/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A small IFC4 house georeferenced in EPSG:2056, written as STEP text, with
 * one element of every candidate kind (and a few that must NOT be picked).
 *
 * Local frame: a 20 m x 10 m box from (0,0) to (20,10); storeys UG at z = -3,
 * EG at 0, OG at 4. The map conversion puts local (0,0,0) at E 2 600 000,
 * N 1 200 000, H 500 and rotates local X 30° counter-clockwise from east.
 */

import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';

export interface SyntheticOptions {
  verticalDatum?: string;
  crsName?: string;
  crsDescription?: string;
  lengthUnit?: 'METRE' | 'MILLIMETRE';
  scale?: number;
  withMapConversion?: boolean;
  /** Write the ground slab (the footprint source). Default true. */
  slab?: boolean;
  /** Add more entities; see {@link Extra}. */
  extra?: (b: Extra) => void;
  /** Storey elevations in metres; default UG -3, EG 0, OG 4. */
  storeyZ?: { ug: number; eg: number; og: number };
}

/** What {@link SyntheticOptions.extra} can use to add entities to the house. */
export interface Extra {
  add(body: string): number;
  guid(): string;
  /** A local placement relative to `rel` (a placement id) at local metres. */
  place(rel: number, x: number, y: number, z: number): number;
  pset(target: number, name: string, prop: string, value: string): void;
  shape(items: number[], id?: string, type?: string): number;
  /** An extruded rectangle (centre, size) at `position` (an IfcAxis2Placement3D id) along `extrude` (an IfcDirection id). */
  rectExtrusion(cx: number, cy: number, xd: number, yd: number, depth: number, position: number, extrude: number): number;
  axis(x: number, y: number, z: number, zDir?: number, xDir?: number): number;
  dir(x: number, y: number, z: number): number;
  pt2(x: number, y: number): number;
  storeys: { ug: { pl: number; id: number }; eg: { pl: number; id: number }; og: { pl: number; id: number } };
  /** The site, to aggregate a further building under it. */
  site: { pl: number; id: number };
  contain(storeyId: number, id: number): void;
}

export const ROTATION_DEG = 30;
export const ORIGIN = { e: 2_600_000, n: 1_200_000, h: 500 };

/** Map coordinates of a local point, by the same rule the model states. */
export function mapOf(x: number, y: number): { x: number; y: number } {
  const a = (ROTATION_DEG * Math.PI) / 180;
  return { x: ORIGIN.e + x * Math.cos(a) - y * Math.sin(a), y: ORIGIN.n + x * Math.sin(a) + y * Math.cos(a) };
}

export function syntheticHouse(o: SyntheticOptions = {}): string {
  const mm = o.lengthUnit === 'MILLIMETRE';
  const k = mm ? 1000 : 1; // local lengths in file units
  const lines: string[] = [];
  let next = 1;
  const add = (body: string): number => {
    const id = next++;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const n = (v: number) => (Number.isInteger(v) ? `${v}.` : String(v));
  const pt = (x: number, y: number, z = 0) => add(`IFCCARTESIANPOINT((${n(x * k)},${n(y * k)},${n(z * k)}))`);
  const pt2 = (x: number, y: number) => add(`IFCCARTESIANPOINT((${n(x * k)},${n(y * k)}))`);
  const dir = (x: number, y: number, z: number) => add(`IFCDIRECTION((${n(x)},${n(y)},${n(z)}))`);
  const axis = (x: number, y: number, z: number, zDir?: number, xDir?: number) =>
    add(`IFCAXIS2PLACEMENT3D(#${pt(x, y, z)},${zDir ? `#${zDir}` : '$'},${xDir ? `#${xDir}` : '$'})`);
  const place = (rel: number | null, x: number, y: number, z: number) =>
    add(`IFCLOCALPLACEMENT(${rel === null ? '$' : `#${rel}`},#${axis(x, y, z)})`);
  let guid = 0;
  const g = () => `'${String(++guid).padStart(22, '0')}'`;

  const unit = add(`IFCSIUNIT(*,.LENGTHUNIT.,${mm ? '.MILLI.' : '$'},.METRE.)`);
  const mapUnit = add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
  const units = add(`IFCUNITASSIGNMENT((#${unit}))`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${axis(0, 0, 0)},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${ctx},$,.MODEL_VIEW.,$)`);
  const project = add(`IFCPROJECT(${g()},$,'House',$,$,$,$,(#${ctx}),#${units})`);
  if (o.withMapConversion !== false) {
    const vd = o.verticalDatum ? `'${o.verticalDatum}'` : '$';
    const crs = add(`IFCPROJECTEDCRS('${o.crsName ?? 'EPSG:2056'}','${o.crsDescription ?? 'CH1903+ / LV95'}','CH1903+',${vd},$,$,#${mapUnit})`);
    const a = (ROTATION_DEG * Math.PI) / 180;
    add(`IFCMAPCONVERSION(#${ctx},#${crs},${n(ORIGIN.e)},${n(ORIGIN.n)},${n(ORIGIN.h)},${Math.cos(a)},${Math.sin(a)},${o.scale === undefined ? '$' : n(o.scale)})`);
  }

  const sitePl = place(null, 0, 0, 0);
  const site = add(`IFCSITE(${g()},$,'Site',$,$,#${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bldPl = place(sitePl, 0, 0, 0);
  const building = add(`IFCBUILDING(${g()},$,'House',$,$,#${bldPl},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,#${site},(#${building}))`);
  const storey = (name: string, z: number) => {
    const pl = place(bldPl, 0, 0, z);
    return { pl, id: add(`IFCBUILDINGSTOREY(${g()},$,'${name}',$,$,#${pl},$,$,.ELEMENT.,${n(z * k)})`) };
  };
  const z = o.storeyZ ?? { ug: -3, eg: 0, og: 4 };
  const ug = storey('UG', z.ug);
  const eg = storey('EG', z.eg);
  const og = storey('OG', z.og);
  add(`IFCRELAGGREGATES(${g()},$,$,$,#${building},(#${ug.id},#${eg.id},#${og.id}))`);

  const contained: Record<number, number[]> = { [ug.id]: [], [eg.id]: [], [og.id]: [] };
  const pset = (target: number, name: string, prop: string, value: string) => {
    const p = add(`IFCPROPERTYSINGLEVALUE('${prop}',$,${value},$)`);
    const s = add(`IFCPROPERTYSET(${g()},$,'${name}',$,(#${p}))`);
    add(`IFCRELDEFINESBYPROPERTIES(${g()},$,$,$,(#${target}),#${s})`);
  };
  const shape = (items: number[], id = 'Body', type = 'SweptSolid') => {
    const rep = add(`IFCSHAPEREPRESENTATION(#${body},'${id}','${type}',(${items.map((i) => `#${i}`).join(',')}))`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
  };
  const rectExtrusion = (cx: number, cy: number, xd: number, yd: number, depth: number, position: number, extrude: number) => {
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${add(`IFCAXIS2PLACEMENT2D(#${pt2(cx, cy)},$)`)},${n(xd * k)},${n(yd * k)})`);
    return add(`IFCEXTRUDEDAREASOLID(#${prof},#${position},#${extrude},${n(depth * k)})`);
  };

  // Ground slab: the footprint.
  if (o.slab !== false) {
    const slabPl = place(eg.pl, 0, 0, 0);
    const slabSolid = rectExtrusion(10, 5, 20, 10, 0.3, axis(0, 0, 0), dir(0, 0, -1));
    const slab = add(`IFCSLAB(${g()},$,'Bodenplatte EG',$,$,#${slabPl},#${shape([slabSolid])},$,.FLOOR.)`);
    contained[eg.id].push(slab);
  }

  // South external wall with an axis.
  const wallPl = place(eg.pl, 0, 0, 0);
  const axisCurve = add(`IFCPOLYLINE((#${pt2(0, 0)},#${pt2(20, 0)}))`);
  const wall = add(`IFCWALL(${g()},$,'Wand Süd',$,$,#${wallPl},#${shape([axisCurve], 'Axis', 'Curve2D')},$,.STANDARD.)`);
  pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  contained[eg.id].push(wall);

  // Door in it: the door says IsExternal = false, the host wall says true.
  // As a real export has it: the opening's extruded body, 1 m x 2.1 m through the wall (x 9.5..10.5, z 0..2.1).
  const doorHole = rectExtrusion(0, 0, 1, 2.1, 0.4, axis(0, -0.2, 1.05, dir(0, 1, 0), dir(1, 0, 0)), dir(0, 0, 1));
  const doorOpening = add(`IFCOPENINGELEMENT(${g()},$,'Öffnung Tür',$,$,#${place(wallPl, 10, 0, 0)},#${shape([doorHole])},$,.OPENING.)`);
  add(`IFCRELVOIDSELEMENT(${g()},$,$,$,#${wall},#${doorOpening})`);
  const door = add(`IFCDOOR(${g()},$,'Haustür',$,$,#${place(eg.pl, 10, 0, 0)},$,$,2.1,1.,.DOOR.,$,$)`);
  pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
  add(`IFCRELFILLSELEMENT(${g()},$,$,$,#${doorOpening},#${door})`);
  contained[eg.id].push(door);

  // Unfilled wall opening placed at the wall origin (as Revit does), hole placed by its extrusion: x 14.5..15.5, z 0.3..1.3.
  const holeSolid = rectExtrusion(0, 0, 1, 1, 0.4, axis(15, -0.2, 0.8, dir(0, 1, 0), dir(1, 0, 0)), dir(0, 0, 1));
  const hole = add(`IFCOPENINGELEMENT(${g()},$,'Lüftung',$,$,#${place(wallPl, 0, 0, 0)},#${shape([holeSolid])},$,.OPENING.)`);
  add(`IFCRELVOIDSELEMENT(${g()},$,$,$,#${wall},#${hole})`);

  // Basement window, light well, boiler, interior and exterior stair, a basement space.
  // Doors and windows carry their own extruded body from their placement up, as a real export does.
  const leaf = (w: number, h: number) => shape([rectExtrusion(0, 0, w, 0.1, h, axis(0, 0, 0), dir(0, 0, 1))]);
  const win = add(`IFCWINDOW(${g()},$,'Kellerfenster',$,$,#${place(ug.pl, 5, 0, 2)},#${leaf(0.8, 0.5)},$,0.5,0.8,.WINDOW.,$,$)`);
  pset(win, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  contained[ug.id].push(win);
  contained[ug.id].push(add(`IFCBUILDINGELEMENTPROXY(${g()},$,'Lichtschacht 1',$,$,#${place(ug.pl, 5, -1, 1.8)},$,$,$)`));
  // Equipment carries its own extruded body from its base up, as a real export does.
  contained[ug.id].push(add(`IFCBOILER(${g()},$,'Heizkessel',$,$,#${place(ug.pl, 12, 4, 0)},#${leaf(0.5, 1)},$,.WATER.)`));
  contained[eg.id].push(add(`IFCELECTRICDISTRIBUTIONBOARD(${g()},$,'Hauptverteilung',$,$,#${place(eg.pl, 2, 5, 0)},#${leaf(0.5, 1)},$,.DISTRIBUTIONBOARD.)`));
  contained[og.id].push(add(`IFCPUMP(${g()},$,'Pumpe OG',$,$,#${place(og.pl, 2, 5, 0)},#${leaf(0.5, 1)},$,.CIRCULATOR.)`));
  contained[ug.id].push(add(`IFCSTAIR(${g()},$,'Kellertreppe aussen',$,$,#${place(ug.pl, 25, 5, 0)},$,$,.STRAIGHT_RUN_STAIR.)`));
  contained[ug.id].push(add(`IFCSTAIR(${g()},$,'Innentreppe',$,$,#${place(ug.pl, 15, 5, 0)},$,$,.STRAIGHT_RUN_STAIR.)`));
  const space = add(`IFCSPACE(${g()},$,'U01',$,$,#${place(ug.pl, 0, 0, 0)},$,'Keller',.ELEMENT.,.SPACE.,$)`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,#${ug.id},(#${space}))`);

  // An upper-floor door in an external wall: out of scope (4 m above the ground storey).
  const ogDoor = add(`IFCDOOR(${g()},$,'Balkontür',$,$,#${place(og.pl, 10, 0, 0)},#${leaf(1, 2.1)},$,2.1,1.,.DOOR.,$,$)`);
  pset(ogDoor, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  contained[og.id].push(ogDoor);

  o.extra?.({
    add,
    guid: g,
    place,
    pset,
    shape,
    rectExtrusion,
    axis,
    dir,
    pt2,
    storeys: { ug, eg, og },
    site: { pl: sitePl, id: site },
    contain: (storeyId, id) => contained[storeyId].push(id),
  });

  for (const [storeyId, ids] of Object.entries(contained)) {
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${g()},$,$,$,(${ids.map((i) => `#${i}`).join(',')}),#${storeyId})`);
  }

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('house.ifc','2026-11-15T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

export async function parseStep(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}
