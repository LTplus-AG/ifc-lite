/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Raw-byte bridge to the bounded Rust LandXML parser. */

import init, { IfcAPI } from '@ifc-lite/wasm';
import type { LandXmlPolyline, LandXmlSourceBuffer, LandXmlTinDocument, LandXmlTinSurface } from './landXmlIngest.js';

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
    hiddenFaceCount: finite(raw.hidden_face_count, 'hidden face count'),
    boundaries: polylines(raw.boundaries, 'boundaries'),
    breaklines: polylines(raw.breaklines, 'breaklines'),
    contours: polylines(raw.contours, 'contours'),
  };
}

function nullableString(value: unknown, context: string): string | null {
  return value === null ? null : string(value, context);
}

function polylines(value: unknown, context: string): LandXmlPolyline[] {
  return array(value, context).map((line, index) => {
    const raw = record(line, `${context} ${index}`);
    return {
      sourceId: string(raw.source_id, `${context} ${index} source id`),
      name: nullableString(raw.name, `${context} ${index} name`),
      kind: nullableString(raw.kind, `${context} ${index} kind`),
      points: array(raw.points, `${context} ${index} points`).map((point, pointIndex) => {
        const values = array(point, `${context} ${index} point ${pointIndex}`);
        if (values.length !== 3) throw new Error(`LandXML WASM returned an invalid ${context} point`);
        return [
          finite(values[0], `${context} ${index} point ${pointIndex} northing`),
          finite(values[1], `${context} ${index} point ${pointIndex} easting`),
          finite(values[2], `${context} ${index} point ${pointIndex} elevation`),
        ];
      }),
    };
  });
}

/** Convert the owned wasm-bindgen serialization into the viewer's TS shape. */
export function readLandXmlTinDocument(value: unknown): LandXmlTinDocument {
  const raw = record(value, 'document');
  const units = raw.units === null ? null : record(raw.units, 'units');
  return {
    version: string(raw.version, 'version'),
    units: units === null ? null : {
      linearUnit: string(units.linear_unit, 'linear unit'),
      elevationUnit: string(units.elevation_unit, 'elevation unit'),
      linearScaleToMeters: finite(units.linear_scale_to_meters, 'linear scale'),
      elevationScaleToMeters: finite(units.elevation_scale_to_meters, 'elevation scale'),
    },
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
