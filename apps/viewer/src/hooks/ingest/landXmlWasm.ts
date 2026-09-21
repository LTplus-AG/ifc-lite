/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Raw-byte bridge to the bounded Rust LandXML parser. */

import { IfcAPI } from '@ifc-lite/wasm';
import type { LandXmlSourceBuffer } from './landXmlIngest.js';
import { initLandXmlWasm } from './landXmlWasmInit.js';
import { pipeNetworks } from './landXmlPipeWasm.js';
import { decodeLandXmlAlignment } from './landXmlAlignmentDocumentWasm.js';
import { decodeLandXmlPlan, decodeLandXmlPlanPoint } from './landXmlPlanWasm.js';
import { clearLandXmlSourceRecordIndex, indexLandXmlSourceRecords } from './landXmlSemantics.js';
import {
  array, finite, nullableFinite, nullableString, properties, record, string, strings,
} from './landXmlWasmDecode.js';
import type {
  LandXmlAlignment,
  LandXmlCapabilityDiagnostic, LandXmlCrossSection, LandXmlCrossSectionPoint,
  LandXmlCrossSectionSurface, LandXmlGradeLine, LandXmlPolyline, LandXmlPreservedOnlyExtension,
  LandXmlProfile, LandXmlProfilePoint, LandXmlRoadway, LandXmlTinDocument, LandXmlTinSurface,
  LandXmlVerticalCurve, LandXmlPlanPoint,
} from './landXmlSemantics.js';

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

function topologyOrigin(value: unknown): NonNullable<LandXmlTinSurface['topologyOrigin']> {
  const origin = string(value, 'terrain topology origin');
  if (origin === 'authored_faces' || origin === 'constrained_triangulation' || origin === 'preserved_only') return origin;
  throw new Error('LandXML WASM returned an invalid terrain topology origin');
}

/** Decode one independently streamed terrain surface using the direct adapter rules. */
export function readLandXmlTinSurface(value: unknown): LandXmlTinSurface {
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
    topologyOrigin: raw.topology_origin === undefined ? undefined : topologyOrigin(raw.topology_origin),
    terrainDiagnostic: raw.terrain_diagnostic === undefined || raw.terrain_diagnostic === null ? null : (() => {
      const diagnostic = record(raw.terrain_diagnostic, 'terrain diagnostic');
      return { code: string(diagnostic.code, 'terrain diagnostic code'), message: string(diagnostic.message, 'terrain diagnostic message') };
    })(),
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
    canonicalVertices: raw.canonical_vertices === undefined ? undefined : array(raw.canonical_vertices, 'canonical terrain vertices').map((vertex, index) => {
      const parsed = record(vertex, `canonical terrain vertex ${index}`);
      return {
        id: string(parsed.id, `canonical terrain vertex ${index} id`),
        northing: finite(parsed.northing, `canonical terrain vertex ${index} northing`),
        easting: finite(parsed.easting, `canonical terrain vertex ${index} easting`),
        elevation: finite(parsed.elevation, `canonical terrain vertex ${index} elevation`),
        contributorSourceIds: strings(parsed.contributor_source_ids, `canonical terrain vertex ${index} contributor source ids`),
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
    return { sourceId: string(source.source_id, `alignment ${index} source id`), ordinal: finite(source.ordinal, `alignment ${index} ordinal`), name: string(source.name, `alignment ${index} name`), length: finite(source.length, `alignment ${index} length`), staStart: finite(source.sta_start, `alignment ${index} staStart`), profileSourceIds: strings(source.profile_source_ids, `alignment ${index} profile ids`), crossSectionSourceIds: strings(source.cross_section_source_ids, `alignment ${index} cross section ids`), segments: [], cantStations: [], superelevations: [], unsupportedTransitions: [] };
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
    surfaces: array(raw.surfaces, 'surfaces').map(readLandXmlTinSurface),
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
    plan: decodeLandXmlPlan(raw.plan),
    pipeNetworks: pipeNetworks(raw.pipe_networks),
    rendering: { meshProvenance: [], surfaceCounts: [] },
  };
  indexLandXmlSourceRecords(document);
  return document;
}

/** Read the one WASM source document used for terrain-only, alignment-only, and mixed files. */
export function readLandXmlSourceDocument(value: unknown): LandXmlTinDocument {
  const raw = record(value, 'source document');
  const document = readLandXmlTinDocument(raw.tin);
  const alignmentDocument = record(raw.alignments, 'alignment document');
  clearLandXmlSourceRecordIndex(document);
  document.alignments = array(alignmentDocument.alignments, 'alignments')
    .map((value, index) => decodeLandXmlAlignment(value, index, document.alignments[index]));
  const renderPoints = new Map<string, LandXmlPlanPoint[]>();
  for (const [index, value] of array(raw.alignment_render_spans ?? [], 'alignment render spans').entries()) {
    const span = record(value, `alignment render span ${index}`);
    renderPoints.set(
      string(span.source_id, `alignment render span ${index} source id`),
      array(span.points, `alignment render span ${index} points`)
        .map((point, pointIndex) => decodeLandXmlPlanPoint(point, `alignment render span ${index} point ${pointIndex}`)),
    );
  }
  for (const alignment of document.alignments) for (const segment of alignment.segments) {
    const points = renderPoints.get(segment.sourceId);
    if (points) segment.renderPoints = points;
  }
  document.warnings.push(...array(alignmentDocument.warnings, 'alignment warnings').map((warning, index) => string(warning, `alignment warning ${index}`)));
  for (const [index, value] of array(raw.alignment_render_refusals ?? [], 'alignment render refusals').entries()) {
    const refusal = record(value, `alignment render refusal ${index}`);
    document.warnings.push(`${string(refusal.source_id, `alignment render refusal ${index} source id`)}: ${string(refusal.message, `alignment render refusal ${index} message`)}`);
  }
  if (raw.alignment_render_truncated === true) document.warnings.push('LandXML alignment overlay sampling stopped at its bounded render budget.');
  return document;
}

/** Parse original XML bytes using an API already owned by the calling realm. */
export function parseLandXmlTinWithApi(api: IfcAPI, buffer: LandXmlSourceBuffer): LandXmlTinDocument {
  return readLandXmlTinDocument(api.parseLandXmlTinBytes(new Uint8Array(buffer)));
}

/** Parse every supported source family through one typed WASM operation. */
export function parseLandXmlSourceWithApi(api: IfcAPI, buffer: LandXmlSourceBuffer): LandXmlTinDocument {
  return readLandXmlSourceDocument(api.parseLandXmlSourceBytes(new Uint8Array(buffer)));
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

export async function parseLandXmlSourceInCurrentRealm(buffer: LandXmlSourceBuffer): Promise<LandXmlTinDocument> {
  await initLandXmlWasm();
  const api = new IfcAPI();
  try {
    return parseLandXmlSourceWithApi(api, buffer);
  } finally {
    api.free();
  }
}
