/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Raw-byte bridge to the bounded Rust LandXML parser. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import type { LandXmlSourceBuffer } from './landXmlIngest.js';
import type { LandXmlPolyline, LandXmlTinDocument, LandXmlTinSurface } from './landXmlSemantics.js';

interface NodeModuleApi {
  createRequire(url: string): { resolve(specifier: string): string };
}

interface NodeFsApi {
  readFile(path: string): Promise<Uint8Array>;
}

async function initLandXmlWasm(): Promise<void> {
  const process = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!process?.versions?.node) {
    await init();
    return;
  }

  // Node cannot fetch wasm-bindgen's file:// URL. Keep these imports hidden
  // behind the runtime gate so Vite never resolves Node built-ins in browsers.
  const moduleSpecifier = 'node:module';
  const fsSpecifier = 'node:fs/promises';
  const nodeModule = await import(/* @vite-ignore */ moduleSpecifier) as unknown as NodeModuleApi;
  const nodeFs = await import(/* @vite-ignore */ fsSpecifier) as unknown as NodeFsApi;
  const wasmPath = nodeModule.createRequire(import.meta.url)
    .resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
  const bytes = await nodeFs.readFile(wasmPath);
  await init({ module_or_path: bytes });
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`LandXML WASM returned an invalid ${context}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`LandXML WASM returned an invalid ${context}`);
  }
  return value;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}

function properties(value: unknown, context: string): Record<string, string> {
  const raw = record(value, context);
  return Object.fromEntries(Object.entries(raw).map(([name, property]) => [name, string(property, `${context} ${name}`)]));
}

function surfaceKind(value: unknown): LandXmlTinSurface['kind'] {
  const kind = string(value, 'surface kind');
  if (kind === 'tin' || kind === 'grid' || kind === 'volume' || kind === 'other') return kind;
  throw new Error('LandXML WASM returned an invalid surface kind');
}

function renderState(value: unknown): LandXmlTinSurface['renderState'] {
  const state = string(value, 'surface render state');
  if (state === 'rendered' || state === 'preserved_only' || state === 'unsupported') return state;
  throw new Error('LandXML WASM returned an invalid surface render state');
}

function surface(value: unknown): LandXmlTinSurface {
  const raw = record(value, 'surface');
  return {
    sourceId: string(raw.source_id, 'surface source id'),
    ordinal: finite(raw.ordinal, 'surface ordinal'),
    sourcePath: string(raw.source_path, 'surface source path'),
    properties: properties(raw.properties, 'surface properties'),
    definitionProperties: properties(raw.definition_properties, 'definition properties'),
    name: string(raw.name, 'surface name'),
    kind: surfaceKind(raw.kind),
    renderState: renderState(raw.render_state),
    points: array(raw.points, 'surface points').map((point, index) => {
      const parsed = record(point, `point ${index}`);
      return {
        sourceId: string(parsed.source_id, `point ${index} source id`),
        id: string(parsed.id, `point ${index} id`),
        northing: finite(parsed.northing, `point ${index} northing`),
        easting: finite(parsed.easting, `point ${index} easting`),
        elevation: finite(parsed.elevation, `point ${index} elevation`),
      };
    }),
    sourceDataPoints: array(raw.source_data_points, 'source data points').map((point, index) => {
      const parsed = record(point, `source data point ${index}`);
      const coordinateDimension = finite(parsed.coordinate_dimension, `source data point ${index} dimension`);
      if (coordinateDimension !== 2 && coordinateDimension !== 3) throw new Error(`LandXML WASM returned an invalid source data point ${index} dimension`);
      return { sourceId: string(parsed.source_id, `source data point ${index} source id`), ordinal: finite(parsed.ordinal, `source data point ${index} ordinal`), sourcePath: string(parsed.source_path, `source data point ${index} path`), coordinateDimension,
        coordinates: array(parsed.coordinates, `source data point ${index} coordinates`).map((value, coordinate) => finite(value, `source data point ${index} coordinate ${coordinate}`)) };
    }),
    faces: array(raw.faces, 'surface faces').map((face, index) => {
      const values = array(face, `face ${index}`);
      if (values.length !== 3) throw new Error(`LandXML WASM returned an invalid face ${index}`);
      return [
        string(values[0], `face ${index} point 0`),
        string(values[1], `face ${index} point 1`),
        string(values[2], `face ${index} point 2`),
      ];
    }),
    faceSourceIds: array(raw.face_source_ids, 'face source ids').map((id, index) => string(id, `face ${index} source id`)),
    faceVisibility: array(raw.face_visibility, 'face visibility').map((visible, index) => {
      if (typeof visible !== 'boolean') throw new Error(`LandXML WASM returned an invalid face ${index} visibility`);
      return visible;
    }),
    hiddenFaceCount: finite(raw.hidden_face_count, 'hidden face count'),
    boundaries: polylines(raw.boundaries, 'boundaries'),
    breaklines: polylines(raw.breaklines, 'breaklines'),
    contours: polylines(raw.contours, 'contours'),
  };
}

function nullableString(value: unknown, context: string): string | null {
  // `serde_wasm_bindgen` omits `None` struct fields rather than always
  // materialising them as JavaScript `null`.
  return value === null || value === undefined ? null : string(value, context);
}

function polylines(value: unknown, context: string): LandXmlPolyline[] {
  return array(value, context).map((line, index) => {
    const raw = record(line, `${context} ${index}`);
    return {
      sourceId: string(raw.source_id, `${context} ${index} source id`),
      ordinal: finite(raw.ordinal, `${context} ${index} ordinal`),
      name: nullableString(raw.name, `${context} ${index} name`),
      kind: nullableString(raw.kind, `${context} ${index} kind`),
      sourcePath: string(raw.source_path, `${context} ${index} source path`),
      properties: properties(raw.properties, `${context} ${index} properties`),
      coordinateDimension: (() => {
        const dimension = finite(raw.coordinate_dimension, `${context} ${index} coordinate dimension`);
        if (dimension === 2 || dimension === 3) return dimension;
        throw new Error(`LandXML WASM returned an invalid ${context} coordinate dimension`);
      })(),
      points: array(raw.points, `${context} ${index} points`).map((point, pointIndex) => {
        const values = array(point, `${context} ${index} point ${pointIndex}`);
        return values.map((coordinate, coordinateIndex) => finite(coordinate, `${context} ${index} point ${pointIndex} coordinate ${coordinateIndex}`));
      }),
      pointSourceIds: array(raw.point_source_ids, `${context} ${index} point source ids`).map((id, pointIndex) => string(id, `${context} ${index} point ${pointIndex} source id`)),
    };
  });
}

/** Convert the owned wasm-bindgen serialization into the viewer's TS shape. */
export function readLandXmlTinDocument(value: unknown): LandXmlTinDocument {
  const raw = record(value, 'document');
  const units = raw.units === null || raw.units === undefined ? null : record(raw.units, 'units');
  const capabilities = record(raw.capabilities, 'capabilities');
  const coordinateSystem = raw.coordinate_system === undefined || raw.coordinate_system === null
    ? undefined
    : record(raw.coordinate_system, 'coordinate system');
  return {
    format: string(raw.format, 'format') === 'landxml' ? 'landxml' : (() => { throw new Error('LandXML WASM returned an invalid format'); })(),
    schema: string(raw.schema, 'schema') === 'LandXML-1.2' ? 'LandXML-1.2' : (() => { throw new Error('LandXML WASM returned an invalid schema'); })(),
    capabilities: {
      renderableTin: capabilities.renderable_tin === true,
      preservedOnlySurfaces: finite(capabilities.preserved_only_surfaces, 'preserved-only surface count'),
      unknownExtensions: finite(capabilities.unknown_extensions, 'unknown extension count'),
    },
    version: string(raw.version, 'version'),
    units: units === null ? null : {
      linearUnit: string(units.linear_unit, 'linear unit'),
      elevationUnit: string(units.elevation_unit, 'elevation unit'),
      linearScaleToMeters: finite(units.linear_scale_to_meters, 'linear scale'),
      elevationScaleToMeters: finite(units.elevation_scale_to_meters, 'elevation scale'),
    },
    ...(coordinateSystem ? {
      coordinateSystem: {
        ...(typeof coordinateSystem.horizontal_datum === 'string' ? { horizontalDatum: coordinateSystem.horizontal_datum } : {}),
        ...(typeof coordinateSystem.vertical_datum === 'string' ? { verticalDatum: coordinateSystem.vertical_datum } : {}),
      },
    } : {}),
    surfaces: array(raw.surfaces, 'surfaces').map(surface),
    extensions: array(raw.extensions, 'extensions').map((extension, index) => {
      const parsed = record(extension, `extension ${index}`);
      return {
        namespace: string(parsed.namespace, `extension ${index} namespace`),
        localName: string(parsed.local_name, `extension ${index} local name`),
        path: string(parsed.path, `extension ${index} path`),
      };
    }),
    warnings: array(raw.warnings, 'warnings').map((warning, index) => string(warning, `warning ${index}`)),
    rendering: { meshProvenance: [], surfaceCounts: [] },
  };
}

/** Parse original XML bytes using an API already owned by the calling realm. */
export function parseLandXmlTinWithApi(api: IfcAPI, buffer: LandXmlSourceBuffer): LandXmlTinDocument {
  return readLandXmlTinDocument(api.parseLandXmlTinBytes(new Uint8Array(buffer)));
}

/** Worker-less hosts use the same raw-byte WASM parser, not a TS fallback. */
export async function parseLandXmlTinInCurrentRealm(buffer: LandXmlSourceBuffer): Promise<LandXmlTinDocument> {
  await initLandXmlWasm();
  const api = new IfcAPI();
  try {
    return parseLandXmlTinWithApi(api, buffer);
  } finally {
    api.free();
  }
}
