/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Raw-byte bridge to the bounded Rust LandXML parser. */

import { IfcAPI } from '@ifc-lite/wasm';
import type { LandXmlSourceBuffer } from './landXmlIngest.js';
import { initLandXmlWasm } from './landXmlWasmInit.js';
import { pipeNetworks } from './landXmlPipeWasm.js';
import { indexLandXmlPlanRecords, indexLandXmlSourceRecords } from './landXmlSemantics.js';
import type {
  LandXmlAlignment, LandXmlCapabilityDiagnostic, LandXmlCrossSection, LandXmlCrossSectionPoint,
  LandXmlCrossSectionSurface, LandXmlGradeLine, LandXmlPolyline, LandXmlPreservedOnlyExtension,
  LandXmlProfile, LandXmlProfilePoint, LandXmlRoadway, LandXmlTinDocument, LandXmlTinSurface,
  LandXmlVerticalCurve,
  LandXmlCgPoint, LandXmlMonument, LandXmlParcel, LandXmlPlanDocument, LandXmlPlanFeature,
  LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation,
  LandXmlParcelProbe, LandXmlResolvedGeometry, LandXmlResolvedMonument,
} from './landXmlSemantics.js';

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

function nullableFinite(value: unknown, context: string): number | null {
  return value === null || value === undefined ? null : finite(value, context);
}

function strings(value: unknown, context: string): string[] {
  return array(value, context).map((entry, index) => string(entry, `${context} ${index}`));
}

function profilePoint(value: unknown, context: string): LandXmlProfilePoint {
  const raw = record(value, context);
  return { sourceId: string(raw.source_id, `${context} source id`), station: finite(raw.station, `${context} station`), elevation: nullableFinite(raw.elevation, `${context} elevation`) };
}

function profile(value: unknown, index: number): LandXmlProfile {
  const raw = record(value, `profile ${index}`);
  const kind = string(raw.kind, `profile ${index} kind`);
  if (kind !== 'design' && kind !== 'sampled') throw new Error(`LandXML WASM returned an invalid profile ${index} kind`);
  const curve = (entry: unknown, curveIndex: number): LandXmlVerticalCurve => {
    const source = record(entry, `profile ${index} curve ${curveIndex}`);
    const curveKind = string(source.kind, `profile ${index} curve ${curveIndex} kind`);
    if (curveKind !== 'parabolic' && curveKind !== 'unsymmetrical_parabolic' && curveKind !== 'circular') throw new Error(`LandXML WASM returned an invalid profile ${index} curve ${curveIndex} kind`);
    return { sourceId: string(source.source_id, `profile ${index} curve ${curveIndex} source id`), parentProfileSourceId: string(source.parent_profile_source_id, `profile ${index} curve ${curveIndex} parent`), kind: curveKind, station: finite(source.station, `profile ${index} curve ${curveIndex} station`), elevation: nullableFinite(source.elevation, `profile ${index} curve ${curveIndex} elevation`), length: nullableFinite(source.length, `profile ${index} curve ${curveIndex} length`), lengthIn: nullableFinite(source.length_in, `profile ${index} curve ${curveIndex} length in`), lengthOut: nullableFinite(source.length_out, `profile ${index} curve ${curveIndex} length out`), radius: nullableFinite(source.radius, `profile ${index} curve ${curveIndex} radius`) };
  };
  const line = (entry: unknown, lineIndex: number): LandXmlGradeLine => {
    const source = record(entry, `profile ${index} grade line ${lineIndex}`);
    return { sourceId: string(source.source_id, `profile ${index} grade line ${lineIndex} source id`), parentProfileSourceId: string(source.parent_profile_source_id, `profile ${index} grade line ${lineIndex} parent`), ordinal: finite(source.ordinal, `profile ${index} grade line ${lineIndex} ordinal`), points: array(source.points, `profile ${index} grade line ${lineIndex} points`).map((point, pointIndex) => profilePoint(point, `profile ${index} grade line ${lineIndex} point ${pointIndex}`)) };
  };
  return { sourceId: string(raw.source_id, `profile ${index} source id`), parentAlignmentSourceId: string(raw.parent_alignment_source_id, `profile ${index} parent alignment`), ordinal: finite(raw.ordinal, `profile ${index} ordinal`), name: string(raw.name, `profile ${index} name`), kind, pvis: array(raw.pvis, `profile ${index} PVIs`).map((point, pointIndex) => profilePoint(point, `profile ${index} PVI ${pointIndex}`)), verticalCurves: array(raw.vertical_curves, `profile ${index} curves`).map(curve), gradeLines: array(raw.grade_lines, `profile ${index} grade lines`).map(line) };
}

function crossSectionPoint(value: unknown, context: string): LandXmlCrossSectionPoint {
  const raw = record(value, context);
  const dataFormat = string(raw.data_format, `${context} data format`);
  if (dataFormat !== 'offset_elevation' && dataFormat !== 'slope_distance') throw new Error(`LandXML WASM returned an invalid ${context} data format`);
  return { sourceId: string(raw.source_id, `${context} source id`), dataFormat, offset: nullableFinite(raw.offset, `${context} offset`), elevation: nullableFinite(raw.elevation, `${context} elevation`), slope: nullableFinite(raw.slope, `${context} slope`), distance: nullableFinite(raw.distance, `${context} distance`), pntRef: nullableString(raw.pnt_ref, `${context} pntRef`), alignmentRef: nullableString(raw.alignment_ref, `${context} alignment ref`), alignRefStation: nullableFinite(raw.align_ref_station, `${context} alignment ref station`), alignmentSourceId: nullableString(raw.alignment_source_id, `${context} alignment source id`), planFeatureRef: nullableString(raw.plan_feature_ref, `${context} plan feature ref`), planFeatureRefStation: nullableFinite(raw.plan_feature_ref_station, `${context} plan feature station`), parcelRef: nullableString(raw.parcel_ref, `${context} parcel ref`), parcelRefStation: nullableFinite(raw.parcel_ref_station, `${context} parcel station`) };
}

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
  const alignments: LandXmlAlignment[] = array(raw.alignments, 'alignments').map((alignment, index) => {
    const source = record(alignment, `alignment ${index}`);
    return { sourceId: string(source.source_id, `alignment ${index} source id`), ordinal: finite(source.ordinal, `alignment ${index} ordinal`), name: string(source.name, `alignment ${index} name`), length: finite(source.length, `alignment ${index} length`), staStart: finite(source.sta_start, `alignment ${index} staStart`), profileSourceIds: strings(source.profile_source_ids, `alignment ${index} profile ids`), crossSectionSourceIds: strings(source.cross_section_source_ids, `alignment ${index} cross section ids`) };
  });
  const crossSections: LandXmlCrossSection[] = array(raw.cross_sections, 'cross sections').map((section, index) => {
    const source = record(section, `cross section ${index}`);
    return { sourceId: string(source.source_id, `cross section ${index} source id`), parentAlignmentSourceId: string(source.parent_alignment_source_id, `cross section ${index} parent alignment`), ordinal: finite(source.ordinal, `cross section ${index} ordinal`), station: finite(source.station, `cross section ${index} station`), surfaceSourceIds: strings(source.surface_source_ids, `cross section ${index} surface ids`) };
  });
  const crossSectionSurfaces: LandXmlCrossSectionSurface[] = array(raw.cross_section_surfaces, 'cross section surfaces').map((surfaceValue, index) => {
    const source = record(surfaceValue, `cross section surface ${index}`);
    const kind = string(source.kind, `cross section surface ${index} kind`);
    if (kind !== 'sampled' && kind !== 'design') throw new Error(`LandXML WASM returned an invalid cross section surface ${index} kind`);
    const segments = array(source.segments, `cross section surface ${index} segments`).map((segmentValue, segmentIndex) => {
      const segment = record(segmentValue, `cross section surface ${index} segment ${segmentIndex}`);
      return { sourceId: string(segment.source_id, `cross section surface ${index} segment ${segmentIndex} source id`), parentSurfaceSourceId: string(segment.parent_surface_source_id, `cross section surface ${index} segment ${segmentIndex} parent`), ordinal: finite(segment.ordinal, `cross section surface ${index} segment ${segmentIndex} ordinal`), points: array(segment.points, `cross section surface ${index} segment ${segmentIndex} points`).map((point, pointIndex) => crossSectionPoint(point, `cross section surface ${index} segment ${segmentIndex} point ${pointIndex}`)) };
    });
    return { sourceId: string(source.source_id, `cross section surface ${index} source id`), parentCrossSectionSourceId: string(source.parent_cross_section_source_id, `cross section surface ${index} parent`), kind, name: nullableString(source.name, `cross section surface ${index} name`), segments, points: array(source.points, `cross section surface ${index} points`).map((point, pointIndex) => crossSectionPoint(point, `cross section surface ${index} point ${pointIndex}`)) };
  });
  const roadways: LandXmlRoadway[] = array(raw.roadways, 'roadways').map((roadway, index) => {
    const source = record(roadway, `roadway ${index}`);
    return { sourceId: string(source.source_id, `roadway ${index} source id`), ordinal: finite(source.ordinal, `roadway ${index} ordinal`), name: string(source.name, `roadway ${index} name`), alignmentRefs: strings(source.alignment_refs, `roadway ${index} alignment refs`), alignmentSourceIds: strings(source.alignment_source_ids, `roadway ${index} alignment ids`), surfaceRefs: strings(source.surface_refs, `roadway ${index} surface refs`), surfaceSourceIds: strings(source.surface_source_ids, `roadway ${index} surface ids`), gradeModelRefs: strings(source.grade_model_refs, `roadway ${index} grade model refs`) };
  });
  const capabilityDiagnostics: LandXmlCapabilityDiagnostic[] = array(raw.capability_diagnostics, 'capability diagnostics').map((diagnostic, index) => {
    const source = record(diagnostic, `capability diagnostic ${index}`);
    return { code: string(source.code, `capability diagnostic ${index} code`), sourceId: nullableString(source.source_id, `capability diagnostic ${index} source id`), sourcePath: string(source.source_path, `capability diagnostic ${index} source path`), message: string(source.message, `capability diagnostic ${index} message`) };
  });
  const preservedOnlyExtensions: LandXmlPreservedOnlyExtension[] = array(raw.preserved_only_extensions, 'preserved-only extensions').map((extension, index) => {
    const source = record(extension, `preserved-only extension ${index}`);
    const kind = string(source.kind, `preserved-only extension ${index} kind`);
    if (kind !== 'corridor' && kind !== 'string_line') throw new Error(`LandXML WASM returned an invalid preserved-only extension ${index} kind`);
    return { sourceId: string(source.source_id, `preserved-only extension ${index} source id`), parentSourceId: nullableString(source.parent_source_id, `preserved-only extension ${index} parent`), localName: string(source.local_name, `preserved-only extension ${index} local name`), sourcePath: string(source.source_path, `preserved-only extension ${index} path`), kind };
  });
  const document: LandXmlTinDocument = {
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
    alignments,
    profiles: array(raw.profiles, 'profiles').map(profile),
    crossSections,
    crossSectionSurfaces,
    roadways,
    capabilityDiagnostics,
    preservedOnlyExtensions,
    plan: plan(raw.plan),
    pipeNetworks: pipeNetworks(raw.pipe_networks),
    rendering: { meshProvenance: [], surfaceCounts: [] },
  };
  indexLandXmlSourceRecords(document);
  return document;
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
