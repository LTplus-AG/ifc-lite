/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Typed, raw-byte bridge for numeric LandXML alignment inspection. */

import { IfcAPI } from '@ifc-lite/wasm';
import type { LandXmlSourceBuffer } from './landXmlIngest.js';
import { initLandXmlWasm } from './landXmlWasm.js';
import type { LandXmlCantStation, LandXmlSuperelevation } from './landXmlSemantics.js';

export interface LandXmlAlignmentProbeResult {
  segmentSourceId: string;
  distance: number;
  northing: number;
  easting: number;
  displayedBack: number;
  displayedAhead: number;
}

export interface LandXmlAlignmentInspectionResult {
  previousCantStation: LandXmlCantStation | null;
  nextCantStation: LandXmlCantStation | null;
  superelevations: LandXmlSuperelevation[];
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}
function finite(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}
function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}
function optionalFinite(value: unknown, context: string): number | null {
  return value === undefined || value === null ? null : finite(value, context);
}
function nullableString(value: unknown, context: string): string | null {
  return value === undefined || value === null ? null : string(value, context);
}

/** Invoke one f64 numeric probe in a non-worker host. */
export async function probeLandXmlAlignmentAtDistance(
  buffer: LandXmlSourceBuffer, alignmentSourceId: string, distance: number, offsetRight = 0,
): Promise<LandXmlAlignmentProbeResult> {
  await initLandXmlWasm();
  const api = new IfcAPI();
  try { return probeLandXmlAlignmentAtDistanceWithApi(api, buffer, alignmentSourceId, distance, offsetRight); }
  finally { api.free(); }
}

/** Decode one native distance probe using an API owned by this realm/worker. */
export function probeLandXmlAlignmentAtDistanceWithApi(
  api: IfcAPI, buffer: LandXmlSourceBuffer, alignmentSourceId: string, distance: number, offsetRight = 0,
): LandXmlAlignmentProbeResult {
  const raw = record(api.probeLandXmlAlignmentAtDistance(new Uint8Array(buffer), alignmentSourceId, distance, offsetRight), 'alignment probe');
  const station = record(raw.station, 'alignment probe station');
  return { segmentSourceId: string(raw.segment_source_id, 'alignment probe segment'), distance: finite(raw.geometric_distance, 'alignment probe distance'), northing: finite(raw.northing, 'alignment probe northing'), easting: finite(raw.easting, 'alignment probe easting'), displayedBack: finite(station.displayed_back, 'alignment probe station back'), displayedAhead: finite(station.displayed_ahead, 'alignment probe station ahead') };
}

/** Resolve the bounded displayed-station result in a non-worker host. */
export async function probeLandXmlAlignmentAtStation(
  buffer: LandXmlSourceBuffer, alignmentSourceId: string, station: number, offsetRight = 0,
): Promise<LandXmlAlignmentProbeResult[]> {
  await initLandXmlWasm();
  const api = new IfcAPI();
  try { return probeLandXmlAlignmentAtStationWithApi(api, buffer, alignmentSourceId, station, offsetRight); }
  finally { api.free(); }
}

/** Decode bounded station probes using an API owned by this realm/worker. */
export function probeLandXmlAlignmentAtStationWithApi(
  api: IfcAPI, buffer: LandXmlSourceBuffer, alignmentSourceId: string, station: number, offsetRight = 0,
): LandXmlAlignmentProbeResult[] {
  return array(api.probeLandXmlAlignmentAtStation(new Uint8Array(buffer), alignmentSourceId, station, offsetRight), 'alignment station probes').map((value, index) => {
    const raw = record(value, `alignment station probe ${index}`);
    const mappedStation = record(raw.station, `alignment station probe ${index} station`);
    return { segmentSourceId: string(raw.segment_source_id, `alignment station probe ${index} segment`), distance: finite(raw.geometric_distance, `alignment station probe ${index} distance`), northing: finite(raw.northing, `alignment station probe ${index} northing`), easting: finite(raw.easting, `alignment station probe ${index} easting`), displayedBack: finite(mappedStation.displayed_back, `alignment station probe ${index} station back`), displayedAhead: finite(mappedStation.displayed_ahead, `alignment station probe ${index} station ahead`) };
  });
}

/** Inspect only authored cant/superelevation records; no interpolation occurs. */
export async function inspectLandXmlAlignmentAtDistance(
  buffer: LandXmlSourceBuffer, alignmentSourceId: string, distance: number,
): Promise<LandXmlAlignmentInspectionResult> {
  await initLandXmlWasm();
  const api = new IfcAPI();
  try { return inspectLandXmlAlignmentAtDistanceWithApi(api, buffer, alignmentSourceId, distance); }
  finally { api.free(); }
}

/** Decode authored cant/superelevation records using an API owned by this realm/worker. */
export function inspectLandXmlAlignmentAtDistanceWithApi(
  api: IfcAPI, buffer: LandXmlSourceBuffer, alignmentSourceId: string, distance: number,
): LandXmlAlignmentInspectionResult {
  const raw = record(api.inspectLandXmlAlignmentAtDistance(new Uint8Array(buffer), alignmentSourceId, distance), 'alignment inspection');
  const cant = raw.cant === undefined || raw.cant === null ? null : record(raw.cant, 'cant inspection');
  const previous = cant?.previous === undefined || cant.previous === null ? null : record(cant.previous, 'previous CantStation');
  const next = cant?.next === undefined || cant.next === null ? null : record(cant.next, 'next CantStation');
  const cantStation = (value: Record<string, unknown> | null, context: string): LandXmlCantStation | null => value === null ? null : {
    sourceId: string(value.source_id, `${context} source id`), station: finite(value.station, `${context} station`),
    appliedCant: finite(value.applied_cant, `${context} applied cant`), equilibriumCant: optionalFinite(value.equilibrium_cant, `${context} equilibrium cant`), transitionType: nullableString(value.transition_type, `${context} transition type`),
  };
  const superelevations: LandXmlSuperelevation[] = array(raw.superelevations, 'superelevations').map((value, index) => {
    const parsed = record(value, `superelevation ${index}`);
    return { sourceId: string(parsed.source_id, `superelevation ${index} source id`), staStart: optionalFinite(parsed.sta_start, `superelevation ${index} start`), staEnd: optionalFinite(parsed.sta_end, `superelevation ${index} end`), events: array(parsed.events, `superelevation ${index} events`).map((event, eventIndex) => { const parsedEvent = record(event, `superelevation ${index} event ${eventIndex}`); return { sourceId: string(parsedEvent.source_id, `superelevation ${index} event ${eventIndex} source id`), kind: string(parsedEvent.kind, `superelevation ${index} event ${eventIndex} kind`), value: nullableString(parsedEvent.value, `superelevation ${index} event ${eventIndex} value`) }; }) };
  });
  return { previousCantStation: cantStation(previous, 'previous CantStation'), nextCantStation: cantStation(next, 'next CantStation'), superelevations };
}
