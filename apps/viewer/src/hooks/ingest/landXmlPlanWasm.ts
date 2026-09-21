/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Strict decoder for Rust-owned LandXML plan and COGO records. */

import { indexLandXmlPlanRecords } from './landXmlSemantics.js';
import type {
  LandXmlCgPoint, LandXmlMonument, LandXmlParcel, LandXmlParcelProbe, LandXmlPlanDocument,
  LandXmlPlanFeature, LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation,
  LandXmlResolvedGeometry, LandXmlResolvedMonument,
} from './landXmlSemantics.js';

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`LandXML WASM returned an invalid ${context}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, context: string): string { if (typeof value !== 'string') throw new Error(`LandXML WASM returned an invalid ${context}`); return value; }
function finite(value: unknown, context: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`LandXML WASM returned an invalid ${context}`); return value; }
function array(value: unknown, context: string): unknown[] { if (!Array.isArray(value)) throw new Error(`LandXML WASM returned an invalid ${context}`); return value; }
function nullableString(value: unknown, context: string): string | null { return value === null || value === undefined ? null : string(value, context); }
function nullableFinite(value: unknown, context: string): number | null { return value === null || value === undefined ? null : finite(value, context); }
function properties(value: unknown, context: string): Record<string, string> { const raw = record(value, context); return Object.fromEntries(Object.entries(raw).map(([name, property]) => [name, string(property, `${context} ${name}`)])); }

function planPoint(value: unknown, context: string): LandXmlPlanPoint {
  const raw = record(value, context);
  return {
    northing: finite(raw.northing, `${context} northing`),
    easting: finite(raw.easting, `${context} easting`),
    elevation: nullableFinite(raw.elevation, `${context} elevation`),
  };
}

function planLocation(value: unknown, context: string): LandXmlPlanPointLocation {
  const raw = record(value, context);
  const kind = string(raw.kind, `${context} kind`);
  if (kind === 'coordinates') {
    return { kind, point: planPoint(raw.point, `${context} point`), pntRef: nullableString(raw.pnt_ref, `${context} pntRef`) };
  }
  if (kind === 'point_reference') return { kind, pntRef: string(raw.pnt_ref, `${context} pntRef`) };
  throw new Error(`LandXML WASM returned an invalid ${context} kind`);
}

function planGeometry(value: unknown, context: string): LandXmlPlanGeometry {
  const raw = record(value, context);
  const kind = string(raw.kind, `${context} kind`);
  if (kind !== 'line' && kind !== 'curve' && kind !== 'irregular_line') {
    throw new Error(`LandXML WASM returned an invalid ${context} kind`);
  }
  return {
    sourceId: string(raw.source_id, `${context} source id`), ordinal: finite(raw.ordinal, `${context} ordinal`), kind,
    pointScopeId: nullableString(raw.point_scope_id, `${context} scope id`),
    start: planLocation(raw.start, `${context} start`), end: planLocation(raw.end, `${context} end`),
    center: raw.center === null || raw.center === undefined ? null : planLocation(raw.center, `${context} center`),
    pi: raw.pi === null || raw.pi === undefined ? null : planLocation(raw.pi, `${context} PI`),
    intermediatePoints: array(raw.intermediate_points, `${context} intermediate points`).map((point, index) => planPoint(point, `${context} intermediate point ${index}`)),
    rotation: nullableString(raw.rotation, `${context} rotation`), radius: nullableFinite(raw.radius, `${context} radius`),
    declaredLength: nullableFinite(raw.declared_length, `${context} declared length`), properties: properties(raw.properties, `${context} properties`),
  };
}

function plan(value: unknown): LandXmlPlanDocument {
  const raw = record(value, 'plan');
  const cogoPoints: LandXmlCgPoint[] = array(raw.cogo_points, 'COGO points').map((point, index) => {
    const parsed = record(point, `COGO point ${index}`);
    return {
      sourceId: string(parsed.source_id, `COGO point ${index} source id`), scopeId: string(parsed.scope_id, `COGO point ${index} scope id`),
      ordinal: finite(parsed.ordinal, `COGO point ${index} ordinal`), name: nullableString(parsed.name, `COGO point ${index} name`),
      code: nullableString(parsed.code, `COGO point ${index} code`), description: nullableString(parsed.description, `COGO point ${index} description`),
      point: parsed.point === null || parsed.point === undefined ? null : planPoint(parsed.point, `COGO point ${index} coordinates`),
      pntRef: nullableString(parsed.pnt_ref, `COGO point ${index} pntRef`), properties: properties(parsed.properties, `COGO point ${index} properties`),
    };
  });
  const monuments: LandXmlMonument[] = array(raw.monuments, 'monuments').map((monument, index) => {
    const parsed = record(monument, `monument ${index}`);
    return {
      sourceId: string(parsed.source_id, `monument ${index} source id`), pointScopeId: nullableString(parsed.point_scope_id, `monument ${index} scope id`),
      ordinal: finite(parsed.ordinal, `monument ${index} ordinal`), name: nullableString(parsed.name, `monument ${index} name`), code: nullableString(parsed.code, `monument ${index} code`),
      description: nullableString(parsed.description, `monument ${index} description`), pntRef: nullableString(parsed.pnt_ref, `monument ${index} pntRef`),
      point: parsed.point === null || parsed.point === undefined ? null : planPoint(parsed.point, `monument ${index} point`), properties: properties(parsed.properties, `monument ${index} properties`),
    };
  });
  const features: LandXmlPlanFeature[] = array(raw.plan_features, 'plan features').map((feature, index) => {
    const parsed = record(feature, `plan feature ${index}`);
    return {
      sourceId: string(parsed.source_id, `plan feature ${index} source id`), ordinal: finite(parsed.ordinal, `plan feature ${index} ordinal`),
      name: nullableString(parsed.name, `plan feature ${index} name`), code: nullableString(parsed.code, `plan feature ${index} code`), description: nullableString(parsed.description, `plan feature ${index} description`),
      properties: properties(parsed.properties, `plan feature ${index} properties`),
      locations: array(parsed.locations, `plan feature ${index} locations`).map((location, item) => planLocation(location, `plan feature ${index} location ${item}`)),
      geometry: array(parsed.geometry, `plan feature ${index} geometry`).map((geometry, item) => planGeometry(geometry, `plan feature ${index} geometry ${item}`)),
    };
  });
  const parcels: LandXmlParcel[] = array(raw.parcels, 'parcels').map((parcel, index) => {
    const parsed = record(parcel, `parcel ${index}`);
    const loops = array(parsed.loops, `parcel ${index} loops`).map((loop, loopIndex) => array(loop, `parcel ${index} loop ${loopIndex}`).map((geometry, item) => planGeometry(geometry, `parcel ${index} loop ${loopIndex} geometry ${item}`)));
    let geometryOffset = 0;
    const loopOffsets = loops.map((loop) => {
      const offset = geometryOffset;
      geometryOffset += loop.length;
      return offset;
    });
    return {
      sourceId: string(parsed.source_id, `parcel ${index} source id`), ordinal: finite(parsed.ordinal, `parcel ${index} ordinal`), name: nullableString(parsed.name, `parcel ${index} name`), code: nullableString(parsed.code, `parcel ${index} code`), description: nullableString(parsed.description, `parcel ${index} description`), title: nullableString(parsed.title, `parcel ${index} title`),
      declaredArea: nullableFinite(parsed.declared_area, `parcel ${index} area`), declaredPerimeter: nullableFinite(parsed.declared_perimeter, `parcel ${index} perimeter`), declaredAreaUnit: nullableString(parsed.declared_area_unit, `parcel ${index} area unit`), properties: properties(parsed.properties, `parcel ${index} properties`),
      loops, loopOffsets,
      preservationReason: nullableString(parsed.preservation_reason, `parcel ${index} preservation reason`),
    };
  });
  const parcelProbes: LandXmlParcelProbe[] = array(raw.parcel_probes, 'parcel probes').map((probe, index) => {
    const parsed = record(probe, `parcel probe ${index}`);
    const state = record(parsed.state, `parcel probe ${index} state`);
    const kind = string(state.kind, `parcel probe ${index} state kind`);
    if (kind !== 'analytic' && kind !== 'preserved_only') throw new Error(`LandXML WASM returned an invalid parcel probe ${index} state`);
    return {
      sourceId: string(parsed.source_id, `parcel probe ${index} source id`),
      state: kind === 'analytic' ? { kind } : { kind, reason: string(state.reason, `parcel probe ${index} reason`) },
      perimeterInDeclaredLinearUnits: nullableFinite(parsed.perimeter_in_declared_linear_units, `parcel probe ${index} perimeter`),
      areaInDeclaredSquareUnits: nullableFinite(parsed.area_in_declared_square_units, `parcel probe ${index} area`),
      declaredArea: nullableFinite(parsed.declared_area, `parcel probe ${index} declared area`),
      declaredPerimeter: nullableFinite(parsed.declared_perimeter, `parcel probe ${index} declared perimeter`),
      perimeterInMeters: nullableFinite(parsed.perimeter_in_meters, `parcel probe ${index} metre perimeter`),
      areaInSquareMeters: nullableFinite(parsed.area_in_square_meters, `parcel probe ${index} square metre area`),
    };
  });
  const resolvedMonuments: LandXmlResolvedMonument[] = array(raw.resolved_monuments, 'resolved monuments').map((monument, index) => {
    const parsed = record(monument, `resolved monument ${index}`);
    return { sourceId: string(parsed.source_id, `resolved monument ${index} source id`), point: parsed.point === null || parsed.point === undefined ? null : planPoint(parsed.point, `resolved monument ${index} point`) };
  });
  const resolvedGeometry: LandXmlResolvedGeometry[] = array(raw.resolved_geometry, 'resolved geometry').map((geometry, index) => {
    const parsed = record(geometry, `resolved geometry ${index}`);
    const resolved = (field: 'start' | 'end' | 'center' | 'pi'): LandXmlPlanPoint | null => parsed[field] === null || parsed[field] === undefined ? null : planPoint(parsed[field], `resolved geometry ${index} ${field}`);
    return { sourceId: string(parsed.source_id, `resolved geometry ${index} source id`), start: resolved('start'), end: resolved('end'), center: resolved('center'), pi: resolved('pi') };
  });
  const result: LandXmlPlanDocument = {
    version: string(raw.version, 'plan version'), areaUnit: nullableString(raw.area_unit, 'plan area unit'), areaScaleToSquareMeters: nullableFinite(raw.area_scale_to_square_meters, 'plan area scale'),
    cogoPoints, monuments, planFeatures: features, parcels,
    warnings: array(raw.warnings, 'plan warnings').map((warning, index) => string(warning, `plan warning ${index}`)),
    sourceBatches: array(raw.source_batches, 'plan source batches').map((batch, index) => {
      const parsed = record(batch, `plan source batch ${index}`);
      return { sourceIds: array(parsed.source_ids, `plan source batch ${index} source ids`).map((sourceId, item) => string(sourceId, `plan source batch ${index} source id ${item}`)) };
    }),
    parcelProbes, resolvedMonuments, resolvedGeometry,
  };
  return {
    ...result,
    sourceRecords: indexLandXmlPlanRecords(result),
    parcelProbesBySource: new Map(parcelProbes.map((probe) => [probe.sourceId, probe])),
    resolvedMonumentsBySource: new Map(resolvedMonuments.map((monument) => [monument.sourceId, monument])),
    resolvedGeometryBySource: new Map(resolvedGeometry.map((geometry) => [geometry.sourceId, geometry])),
  };
}

export const decodeLandXmlPlan = plan;
export const decodeLandXmlPlanPoint = planPoint;

