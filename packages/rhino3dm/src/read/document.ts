/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isValidIfcGuid } from '@ifc-lite/encoding';
import type { RhinoColor, RhinoUserStrings, RhinoVector3 } from '../types.js';
import { dispose } from '../runtime.js';
import type { AppearanceTables } from './appearance.js';
import type { IfcClasses } from './ifc-classes.js';
import { NOT_3DM_MESSAGE } from './header.js';
import { ifcString } from './identity.js';
import type { Report } from './report.js';
import type { RFile, RLayer, ReadApi, Rgba8 } from './rhino-api.js';
import { RhinoReadError, type RhinoImportDocument, type RhinoImportLayer } from './types.js';
import { parseXform, transformPoint, type Xform } from './xform.js';

/** Metres per unit by `UnitSystem` name. None, CustomUnits and Unset have no scale (rhino3dm.js exposes none). */
const UNITS: Record<string, number | null> = {
  None: null, Angstroms: 1e-10, Nanometers: 1e-9, Microns: 1e-6, Millimeters: 1e-3, Centimeters: 1e-2,
  Decimeters: 1e-1, Meters: 1, Dekameters: 10, Hectometers: 100, Kilometers: 1e3, Megameters: 1e6,
  Gigameters: 1e9, Microinches: 2.54e-8, Mils: 2.54e-5, Inches: 0.0254, Feet: 0.3048, Yards: 0.9144,
  Miles: 1609.344, PrinterPoints: 0.0254 / 72, PrinterPicas: 0.0254 / 6, NauticalMiles: 1852,
  AstronomicalUnits: 1.4959787e11, LightYears: 9.4607304725808e15, Parsecs: 3.08567758e16,
  CustomUnits: null, Unset: null,
};

const NIL_ID = '00000000-0000-0000-0000-000000000000';
/**
 * Rhino's layer path separator. A layer name cannot hold it: Rhino reads `A::B` as child `B` of
 * `A`, and our exporter replaces it in any name it writes (`rust/export/src/rhino/names.rs`).
 */
const LAYER_PATH_SEPARATOR = '::';
const color = (c: Rgba8): RhinoColor => [c.r, c.g, c.b, c.a];

export interface DocumentTables extends AppearanceTables {
  document: RhinoImportDocument;
  /** `IFC::WorldFromModel` in metres when it applies, else null. */
  world: Xform | null;
  /** Output layers, parent first, and never empty: a file without layers gets a `Default` one. */
  layers: (RhinoImportLayer & { material: number; hidden: boolean })[];
  materials: { name: string; diffuse: RhinoColor; transparency: number }[];
  /** File layer index to output layer index. */
  layerIndex: number[];
  groupNames: string[];
}

/**
 * A row as the binding handed it out. The layer, material, group and definition tables answer null
 * for a row they cannot hand out, as they do for an index past `count` [measured]; the string
 * table answers an empty pair instead [measured]. A table that disagrees with its own count is a
 * damaged file, reported as one rather than left to escape as a bare TypeError from whatever reads
 * the row. Every table this file reads goes through here. The objects table is read in `read.ts`,
 * which counts a row the binding will not wrap and reads on: one object is not the document.
 */
function handed<T>(row: T | null | undefined): T {
  if (row == null) throw new RhinoReadError('not-3dm', NOT_3DM_MESSAGE);
  return row;
}

/** Read each row of a table, releasing the row wrappers and then the table. */
export function rows<T, R>(table: { count: number; get(index: number): T }, read: (row: T) => R): R[] {
  try {
    return Array.from({ length: table.count }, (_, i) => {
      const row = handed(table.get(i));
      try { return read(row); } finally { dispose(row); }
    });
  } finally { dispose(table); }
}

function spatialStamp(strings: RhinoUserStrings, classes: IfcClasses): RhinoImportLayer['spatial'] {
  const globalId = ifcString(strings, 'GlobalId'), ifcClass = classes.spatial(ifcString(strings, 'Class') ?? '');
  if (!globalId || !isValidIfcGuid(globalId) || !ifcClass) return null;
  const text = ifcString(strings, 'Elevation')?.trim(), elevation = text ? Number(text) : NaN;
  return { globalId, ifcClass, elevation: Number.isFinite(elevation) ? elevation : null };
}

/**
 * Order layers parent first, keeping file order among siblings. A layer whose
 * parent is missing or part of a parent cycle becomes a root. The walk is
 * iterative with a visited set, so no layer chain can overflow the stack.
 *
 * Each path is built from the parent this walk settled on, not from the
 * native `fullPath`: rhino3dm 8.35.0 follows `ParentId` with no visited set,
 * so reading that property for a cyclic chain does not return [measured: the
 * read was still running after 90 s on a model built in memory]. Building it
 * here also keeps the path and the repaired tree in step, so a layer this walk
 * shows at the top level is named as one.
 */
export function orderLayers(source: RLayerFacts[], classes: IfcClasses, report: Report): Pick<DocumentTables, 'layers' | 'layerIndex'> {
  const byId = new Map(source.map((l, i) => [l.id, i]));
  const children = source.map((): number[] => []), roots: number[] = [];
  source.forEach((l, i) => {
    const parent = l.parentId === NIL_ID ? undefined : byId.get(l.parentId);
    if (parent === undefined || parent === i) roots.push(i); else children[parent].push(i);
  });
  const layers: DocumentTables['layers'] = [], layerIndex = new Array<number>(source.length).fill(-1);
  const place = (root: number) => {
    const stack: [index: number, parent: number | null][] = [[root, null]];
    for (let next = stack.pop(); next; next = stack.pop()) {
      const [i, parent] = next, l = source[i];
      if (layerIndex[i] >= 0) continue;
      layerIndex[i] = layers.length;
      layers.push({
        name: l.name, fullPath: parent === null ? l.name : `${layers[parent].fullPath}${LAYER_PATH_SEPARATOR}${l.name}`,
        parent, color: l.color, visible: l.visible, userStrings: l.userStrings,
        spatial: spatialStamp(l.userStrings, classes), material: l.material,
        hidden: !l.visible || (parent !== null && layers[parent].hidden),
      });
      for (let c = children[i].length - 1; c >= 0; c--) stack.push([children[i][c], layerIndex[i]]);
    }
  };
  roots.forEach(place);
  source.forEach((_, i) => {
    if (layerIndex[i] >= 0) return;
    report.warn('layer-cycle', () => 'Some layers are their own ancestors; they are shown at the top level.');
    place(i);
  });
  if (layers.length === 0) {
    layers.push({ name: 'Default', fullPath: 'Default', parent: null, color: [0, 0, 0, 255], visible: true, userStrings: [], spatial: null, material: -1, hidden: false });
  }
  return { layers, layerIndex };
}

export interface RLayerFacts {
  id: string; parentId: string; name: string; color: RhinoColor;
  visible: boolean; material: number; userStrings: RhinoUserStrings;
}
const layerFacts = (l: RLayer): RLayerFacts => ({
  id: l.id, parentId: l.parentLayerId, name: l.name, color: color(l.color),
  visible: l.visible, material: l.renderMaterialIndex, userStrings: l.getUserStrings(),
});

/** Read everything that is not an object: units, frame, anchor, strings, layers, materials and groups. */
export function readDocument(api: ReadApi, file: RFile, archiveVersion: number, classes: IfcClasses, report: Report): DocumentTables {
  // String table rows are plain pairs, not wrappers, so there is nothing to release per row. This
  // is the one table the reader walks itself, so the pair goes through `handed` like the others,
  // but it catches less here: the table answers an empty pair rather than null for a row it will
  // not hand out [measured], so only a change in the binding reaches the guard.
  const table = file.strings(), strings: RhinoUserStrings = [];
  try {
    for (let i = 0; i < table.count; i++) { const [key, value] = handed(table.get(i)); strings.push([key, value]); }
  } finally { dispose(table); }
  const settings = file.settings();
  let unitSystem = 'Unset', metersPerUnit: number | null = null, earthAnchor: RhinoImportDocument['earthAnchor'] = null;
  try {
    const unit = settings.modelUnitSystem.value;
    unitSystem = Object.keys(UNITS).find(name => api.UnitSystem[name]?.value === unit) ?? unitSystem;
    metersPerUnit = UNITS[unitSystem];
    const metres = metersPerUnit ?? 1, anchor = settings.earthAnchorPoint;
    try {
      const latitude = anchor.earthBasepointLatitude, longitude = anchor.earthBasepointLongitude;
      const elevation = anchor.earthBasepointElevation, base = anchor.modelBasePoint;
      // Rhino 8 marks its default 0/0 anchor as set; treat it as absent.
      const real = anchor.earthLocationIsSet() && (latitude !== 0 || longitude !== 0);
      const modelBasePoint: RhinoVector3 = [base[0] * metres, base[1] * metres, base[2] * metres];
      if (real && [latitude, longitude, elevation, ...modelBasePoint].every(Number.isFinite)) earthAnchor = { latitude, longitude, elevation, modelBasePoint };
    } finally { dispose(anchor); }
  } finally { dispose(settings); }
  if (metersPerUnit === null) report.warn('units', () => `The file's unit system is ${unitSystem}, which has no scale; coordinates are read as metres.`);

  let world: Xform | null = null;
  const worldText = ifcString(strings, 'WorldFromModel');
  // Exports before the fix wrote the matrix under `world` too, where it must not be applied again.
  if (worldText !== undefined && ifcString(strings, 'Coordinates') === 'local') {
    world = parseXform(worldText);
    if (!world) report.warn('world', () => 'IFC::WorldFromModel is not a usable 4×4 matrix; the file is shown in its own coordinates.');
  }
  // The anchor's base point is a model coordinate like any other, so it moves with the frame.
  if (world && earthAnchor) earthAnchor.modelBasePoint = transformPoint(world, earthAnchor.modelBasePoint);
  const materials = rows(file.materials(), m => ({ name: m.name, diffuse: color(m.diffuseColor), transparency: m.transparency }));
  return {
    document: {
      archiveVersion, application: file.applicationName, unitSystem, metersPerUnit: metersPerUnit ?? 1,
      provenance: ifcString(strings, 'Exporter')?.startsWith('ifc-lite') ? 'ifc-lite' : 'rhino',
      frame: world ? 'ifc-world-from-model' : 'file', earthAnchor, strings,
    },
    world,
    ...orderLayers(rows(file.layers(), layerFacts), classes, report),
    materials,
    groupNames: rows(file.groups(), g => g.name),
  };
}
