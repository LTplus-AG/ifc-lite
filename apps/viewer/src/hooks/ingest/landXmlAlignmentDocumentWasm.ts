/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict decoder for the durable Rust LandXML alignment document. */

import type {
  LandXmlAlignment, LandXmlAlignmentPi, LandXmlAlignmentPrimitive, LandXmlAlignmentSegment,
  LandXmlCant, LandXmlCantStation, LandXmlPlanPoint, LandXmlPointLocation, LandXmlRadius,
  LandXmlStationEquation, LandXmlSuperelevation, LandXmlUnsupportedTransition,
} from './landXmlSemantics.js';

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
function optionalBoolean(value: unknown, context: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value;
}
function planPoint(value: unknown, context: string): LandXmlPlanPoint {
  const raw = record(value, context);
  return { northing: finite(raw.northing, `${context} northing`), easting: finite(raw.easting, `${context} easting`), elevation: optionalFinite(raw.elevation, `${context} elevation`) };
}
function pointLocation(value: unknown, context: string): LandXmlPointLocation {
  const raw = record(value, context);
  const kind = string(raw.kind, `${context} kind`);
  if (kind === 'coordinates') return { kind, point: planPoint(raw.point, `${context} point`) };
  if (kind === 'point_reference') return { kind, pntRef: string(raw.pnt_ref, `${context} pntRef`) };
  throw new Error(`LandXML WASM returned an invalid ${context} kind`);
}
function rotation(value: unknown, context: string): 'clockwise' | 'counter_clockwise' {
  const parsed = string(value, context);
  if (parsed === 'clockwise' || parsed === 'counter_clockwise') return parsed;
  throw new Error(`LandXML WASM returned an invalid ${context}`);
}
function radius(value: unknown, context: string): LandXmlRadius {
  if (value === 'infinite') return value;
  return finite(record(value, context).finite, `${context} finite value`);
}
function primitive(value: unknown, context: string): LandXmlAlignmentPrimitive {
  const raw = record(value, context);
  const kind = string(raw.kind, `${context} kind`);
  const start = pointLocation(raw.start, `${context} start`);
  const end = pointLocation(raw.end, `${context} end`);
  if (kind === 'line') return { kind, start, end, declaredLength: optionalFinite(raw.declared_length, `${context} length`) };
  if (kind === 'irregular_line') return { kind, start, end, declaredLength: optionalFinite(raw.declared_length, `${context} length`), points: array(raw.points, `${context} points`).map((point, index) => planPoint(point, `${context} point ${index}`)) };
  if (kind === 'curve') return { kind, start, end, center: pointLocation(raw.center, `${context} center`), pi: raw.pi === undefined || raw.pi === null ? null : pointLocation(raw.pi, `${context} PI`), rotation: rotation(raw.rotation, `${context} rotation`), radius: optionalFinite(raw.radius, `${context} radius`), declaredLength: optionalFinite(raw.declared_length, `${context} length`) };
  if (kind === 'spiral' || kind === 'unsupported_spiral') return { kind, start, end, pi: pointLocation(raw.pi, `${context} PI`), spiType: string(raw.spi_type, `${context} type`), radiusStart: radius(raw.radius_start, `${context} start radius`), radiusEnd: radius(raw.radius_end, `${context} end radius`), rotation: rotation(raw.rotation, `${context} rotation`), declaredLength: finite(raw.declared_length, `${context} length`) };
  throw new Error(`LandXML WASM returned an invalid ${context} primitive`);
}

export function decodeLandXmlCantStation(value: unknown, context: string): LandXmlCantStation {
  const parsed = record(value, context);
  return { sourceId: string(parsed.source_id, `${context} source id`), station: finite(parsed.station, `${context} station`), appliedCant: finite(parsed.applied_cant, `${context} applied cant`), equilibriumCant: optionalFinite(parsed.equilibrium_cant, `${context} equilibrium cant`), curvature: rotation(parsed.curvature, `${context} curvature`), cantDeficiency: optionalFinite(parsed.cant_deficiency, `${context} cant deficiency`), cantExcess: optionalFinite(parsed.cant_excess, `${context} cant excess`), rateOfChangeOfAppliedCantOverTime: optionalFinite(parsed.rate_of_change_of_applied_cant_over_time, `${context} applied cant time rate`), rateOfChangeOfAppliedCantOverLength: optionalFinite(parsed.rate_of_change_of_applied_cant_over_length, `${context} applied cant length rate`), rateOfChangeOfCantDeficiencyOverTime: optionalFinite(parsed.rate_of_change_of_cant_deficiency_over_time, `${context} deficiency time rate`), cantGradient: optionalFinite(parsed.cant_gradient, `${context} gradient`), speed: optionalFinite(parsed.speed, `${context} speed`), transitionType: nullableString(parsed.transition_type, `${context} transition type`), adverse: optionalBoolean(parsed.adverse, `${context} adverse flag`) };
}

export function decodeLandXmlAlignment(value: unknown, index: number, semantic?: LandXmlAlignment): LandXmlAlignment {
  const raw = record(value, `alignment ${index}`);
  const cant = raw.cant === undefined || raw.cant === null ? null : record(raw.cant, `alignment ${index} cant`);
  const cantStations: LandXmlCantStation[] = cant === null ? [] : array(cant.stations, `alignment ${index} cant stations`).map((station, stationIndex) => decodeLandXmlCantStation(station, `alignment ${index} cant station ${stationIndex}`));
  const decodedCant: LandXmlCant | null = cant === null ? null : {
    sourceId: string(cant.source_id, `alignment ${index} cant source id`),
    name: string(cant.name, `alignment ${index} cant name`),
    gauge: finite(cant.gauge, `alignment ${index} cant gauge`),
    rotationPoint: nullableString(cant.rotation_point, `alignment ${index} cant rotation point`),
    equilibriumConstant: optionalFinite(cant.equilibrium_constant, `alignment ${index} cant equilibrium constant`),
    appliedCantConstant: optionalFinite(cant.applied_cant_constant, `alignment ${index} cant applied constant`),
    stations: cantStations,
    speedStations: array(cant.speed_stations, `alignment ${index} speed stations`).map((value, stationIndex) => { const station = record(value, `alignment ${index} speed station ${stationIndex}`); return { sourceId: string(station.source_id, `alignment ${index} speed station ${stationIndex} source id`), station: finite(station.station, `alignment ${index} speed station ${stationIndex} station`), speed: finite(station.speed, `alignment ${index} speed station ${stationIndex} speed`) }; }),
  };
  const superelevations: LandXmlSuperelevation[] = array(raw.superelevations, `alignment ${index} superelevations`).map((value, itemIndex) => {
    const parsed = record(value, `alignment ${index} superelevation ${itemIndex}`);
    return { sourceId: string(parsed.source_id, `alignment ${index} superelevation ${itemIndex} source id`), staStart: optionalFinite(parsed.sta_start, `alignment ${index} superelevation ${itemIndex} start`), staEnd: optionalFinite(parsed.sta_end, `alignment ${index} superelevation ${itemIndex} end`), events: array(parsed.events, `alignment ${index} superelevation ${itemIndex} events`).map((event, eventIndex) => { const item = record(event, `alignment ${index} superelevation ${itemIndex} event ${eventIndex}`); return { sourceId: string(item.source_id, 'superelevation event source id'), kind: string(item.kind, 'superelevation event kind'), value: nullableString(item.value, 'superelevation event value') }; }) };
  });
  const unsupportedTransitions: LandXmlUnsupportedTransition[] = array(raw.unsupported_transitions, `alignment ${index} unsupported transitions`).map((value, itemIndex) => {
    const parsed = record(value, `alignment ${index} unsupported transition ${itemIndex}`);
    const sourceSourceId = string(parsed.source_id, `alignment ${index} unsupported transition ${itemIndex} source id`);
    return { sourceId: `${sourceSourceId}:refusal`, sourceSourceId, spiType: string(parsed.spi_type, 'unsupported transition type'), reason: string(parsed.reason, 'unsupported transition reason') };
  });
  const alignPis: LandXmlAlignmentPi[] = array(raw.align_pis, `alignment ${index} PIs`).map((value, itemIndex) => { const parsed = record(value, `alignment ${index} PI ${itemIndex}`); return { sourceId: string(parsed.source_id, `alignment ${index} PI ${itemIndex} source id`), location: pointLocation(parsed.location, `alignment ${index} PI ${itemIndex} location`) }; });
  const stationEquations: LandXmlStationEquation[] = array(raw.station_equations, `alignment ${index} station equations`).map((value, itemIndex) => { const parsed = record(value, `alignment ${index} station equation ${itemIndex}`); return { sourceId: string(parsed.source_id, 'station equation source id'), staInternal: finite(parsed.sta_internal, 'station equation internal station'), staAhead: finite(parsed.sta_ahead, 'station equation ahead station'), staBack: optionalFinite(parsed.sta_back, 'station equation back station'), staIncrement: nullableString(parsed.sta_increment, 'station equation increment') }; });
  return {
    sourceId: string(raw.source_id, `alignment ${index} source id`), ordinal: finite(raw.ordinal, `alignment ${index} ordinal`), name: string(raw.name, `alignment ${index} name`), length: finite(raw.length, `alignment ${index} length`), staStart: finite(raw.sta_start, `alignment ${index} staStart`), profileSourceIds: semantic?.profileSourceIds ?? [], crossSectionSourceIds: semantic?.crossSectionSourceIds ?? [], start: raw.start === undefined || raw.start === null ? null : pointLocation(raw.start, `alignment ${index} start`), alignPis, stationEquations,
    segments: array(raw.segments, `alignment ${index} segments`).map((segment, itemIndex): LandXmlAlignmentSegment => { const parsed = record(segment, `alignment ${index} segment ${itemIndex}`); return { sourceId: string(parsed.source_id, `alignment ${index} segment ${itemIndex} source id`), ordinal: finite(parsed.ordinal, `alignment ${index} segment ${itemIndex} ordinal`), primitive: primitive(parsed.primitive, `alignment ${index} segment ${itemIndex} primitive`) }; }),
    cant: decodedCant, cantStations, superelevations, unsupportedTransitions,
  };
}
