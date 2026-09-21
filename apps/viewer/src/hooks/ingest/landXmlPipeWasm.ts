/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LandXmlPipeMeasure, LandXmlPipeNetworkDocument, LandXmlPipePosition, LandXmlPipeUnits } from './landXmlDocumentTypes.js';
import { isLandXmlSchema } from './landXmlSemantics.js';
import type { LandXmlCapabilityDiagnostic } from './landXmlSemantics.js';

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
function properties(value: unknown, context: string): Record<string, string> {
  const raw = record(value, context);
  return Object.fromEntries(Object.entries(raw).map(([name, property]) => [name, string(property, `${context} ${name}`)]));
}
function nullableString(value: unknown, context: string): string | null {
  return value === null || value === undefined ? null : string(value, context);
}
function nullableMeasure(value: unknown, context: string): LandXmlPipeMeasure | null {
  if (value === null || value === undefined) return null;
  const raw = record(value, context);
  return { value: finite(raw.value, `${context} value`), unit: string(raw.unit, `${context} unit`), meters: finite(raw.meters, `${context} meters`) };
}
function pipePosition(value: unknown, context: string): LandXmlPipePosition {
  const raw = record(value, context);
  return { northing: finite(raw.northing, `${context} northing`), easting: finite(raw.easting, `${context} easting`), northingMeters: finite(raw.northing_meters, `${context} northing meters`), eastingMeters: finite(raw.easting_meters, `${context} easting meters`), elevation: nullableMeasure(raw.elevation, `${context} elevation`) };
}
function pipeUnits(value: unknown, context: string): LandXmlPipeUnits {
  const raw = record(value, context);
  return { linearUnit: string(raw.linear_unit, `${context} linear unit`), elevationUnit: string(raw.elevation_unit, `${context} elevation unit`), diameterUnit: string(raw.diameter_unit, `${context} diameter unit`), widthUnit: string(raw.width_unit, `${context} width unit`), heightUnit: string(raw.height_unit, `${context} height unit`), flowUnit: nullableString(raw.flow_unit, `${context} flow unit`), linearScaleToMeters: finite(raw.linear_scale_to_meters, `${context} linear scale`), elevationScaleToMeters: finite(raw.elevation_scale_to_meters, `${context} elevation scale`), diameterScaleToMeters: finite(raw.diameter_scale_to_meters, `${context} diameter scale`), widthScaleToMeters: finite(raw.width_scale_to_meters, `${context} width scale`), heightScaleToMeters: finite(raw.height_scale_to_meters, `${context} height scale`) };
}
function pipeKind(value: unknown, context: string): 'circular' | 'elliptical' | 'egg' | 'rectangular' {
  const kind = string(value, context);
  if (kind === 'circular' || kind === 'elliptical' || kind === 'egg' || kind === 'rectangular') return kind;
  throw new Error(`LandXML WASM returned an invalid ${context}`);
}
function structureKind(value: unknown, context: string): 'circular' | 'rectangular' | 'inlet' | 'outlet' | 'connection' {
  const kind = string(value, context);
  if (kind === 'circular' || kind === 'rectangular' || kind === 'inlet' || kind === 'outlet' || kind === 'connection') return kind;
  throw new Error(`LandXML WASM returned an invalid ${context}`);
}
function pipeGeometryKind(value: unknown, context: string): 'straight' | 'pass_through' {
  const kind = string(value, context);
  if (kind === 'straight' || kind === 'pass_through') return kind;
  throw new Error(`LandXML WASM returned an invalid ${context}`);
}

/** Adapt the optional pipe-network branch from the owned wasm-bindgen value. */
export function pipeNetworks(value: unknown): LandXmlPipeNetworkDocument | null {
  if (value === null || value === undefined) return null;
  const raw = record(value, 'pipe networks');
  const feature = (value: unknown, context: string) => {
    const item = record(value, context);
    return { sourceId: string(item.source_id, `${context} source id`), sourcePath: string(item.source_path, `${context} source path`), ownerSourceId: string(item.owner_source_id, `${context} owner source id`), properties: properties(item.properties, `${context} properties`) };
  };
  const flow = (value: unknown, context: string) => {
    if (value === null || value === undefined) return null;
    const item = record(value, context);
    return { sourceId: string(item.source_id, `${context} source id`), sourcePath: string(item.source_path, `${context} source path`), unit: nullableString(item.unit, `${context} unit`), flowIn: item.flow_in === null || item.flow_in === undefined ? null : finite(item.flow_in, `${context} flow in`), lossIn: item.loss_in === null || item.loss_in === undefined ? null : finite(item.loss_in, `${context} loss in`), lossOut: item.loss_out === null || item.loss_out === undefined ? null : finite(item.loss_out, `${context} loss out`), properties: properties(item.properties, `${context} properties`) };
  };
  const networks = array(raw.networks, 'pipe networks').map((value, index) => {
    const network = record(value, `pipe network ${index}`);
    return {
      sourceId: string(network.source_id, `pipe network ${index} source id`), sourcePath: string(network.source_path, `pipe network ${index} source path`), name: string(network.name, `pipe network ${index} name`), pipeNetworkType: string(network.pipe_network_type, `pipe network ${index} type`), properties: properties(network.properties, `pipe network ${index} properties`), structureUnits: network.structure_units === null || network.structure_units === undefined ? null : pipeUnits(network.structure_units, `pipe network ${index} structure units`), pipeUnits: network.pipe_units === null || network.pipe_units === undefined ? null : pipeUnits(network.pipe_units, `pipe network ${index} pipe units`),
      features: array(network.features, `pipe network ${index} features`).map((item, itemIndex) => feature(item, `pipe network ${index} feature ${itemIndex}`)),
      structures: array(network.structures, `pipe network ${index} structures`).map((value, itemIndex) => {
        const structure = record(value, `pipe structure ${itemIndex}`);
        const part = record(structure.part, `pipe structure ${itemIndex} part`);
        return { sourceId: string(structure.source_id, `pipe structure ${itemIndex} source id`), sourcePath: string(structure.source_path, `pipe structure ${itemIndex} source path`), name: string(structure.name, `pipe structure ${itemIndex} name`), properties: properties(structure.properties, `pipe structure ${itemIndex} properties`), units: pipeUnits(structure.units, `pipe structure ${itemIndex} units`), center: pipePosition(structure.center, `pipe structure ${itemIndex} center`), part: { kind: structureKind(part.kind, `pipe structure ${itemIndex} part kind`), properties: properties(part.properties, `pipe structure ${itemIndex} part properties`), diameter: nullableMeasure(part.diameter, `pipe structure ${itemIndex} diameter`) ?? undefined, length: nullableMeasure(part.length, `pipe structure ${itemIndex} length`) ?? undefined, width: nullableMeasure(part.width, `pipe structure ${itemIndex} width`) ?? undefined, thickness: nullableMeasure(part.thickness, `pipe structure ${itemIndex} thickness`) ?? undefined, material: nullableString(part.material, `pipe structure ${itemIndex} material`) }, rimElevation: nullableMeasure(structure.rim_elevation, `pipe structure ${itemIndex} rim elevation`), sumpElevation: nullableMeasure(structure.sump_elevation, `pipe structure ${itemIndex} sump elevation`), inverts: array(structure.inverts, `pipe structure ${itemIndex} inverts`).map((value, invertIndex) => { const invert = record(value, `pipe structure ${itemIndex} invert ${invertIndex}`); return { sourceId: string(invert.source_id, `pipe structure ${itemIndex} invert ${invertIndex} source id`), sourcePath: string(invert.source_path, `pipe structure ${itemIndex} invert ${invertIndex} source path`), pipeSourceId: string(invert.pipe_source_id, `pipe structure ${itemIndex} invert ${invertIndex} pipe source id`), flowDirection: string(invert.flow_direction, `pipe structure ${itemIndex} invert ${invertIndex} flow direction`), elevation: nullableMeasure(invert.elevation, `pipe structure ${itemIndex} invert ${invertIndex} elevation`) ?? (() => { throw new Error(`LandXML WASM returned an invalid pipe structure ${itemIndex} invert ${invertIndex} elevation`); })(), properties: properties(invert.properties, `pipe structure ${itemIndex} invert ${invertIndex} properties`) }; }), flow: flow(structure.flow, `pipe structure ${itemIndex} flow`) };
      }),
      pipes: array(network.pipes, `pipe network ${index} pipes`).map((value, itemIndex) => {
        const pipe = record(value, `pipe ${itemIndex}`), connectivity = record(pipe.connectivity, `pipe ${itemIndex} connectivity`), part = record(pipe.part, `pipe ${itemIndex} part`), geometry = record(pipe.geometry, `pipe ${itemIndex} geometry`);
        const geometryKind = pipeGeometryKind(geometry.kind, `pipe ${itemIndex} geometry kind`);
        return { sourceId: string(pipe.source_id, `pipe ${itemIndex} source id`), sourcePath: string(pipe.source_path, `pipe ${itemIndex} source path`), name: string(pipe.name, `pipe ${itemIndex} name`), properties: properties(pipe.properties, `pipe ${itemIndex} properties`), units: pipeUnits(pipe.units, `pipe ${itemIndex} units`), connectivity: { startStructureSourceId: string(connectivity.start_structure_source_id, `pipe ${itemIndex} start`), endStructureSourceId: string(connectivity.end_structure_source_id, `pipe ${itemIndex} end`) }, part: { kind: pipeKind(part.kind, `pipe ${itemIndex} part kind`), properties: properties(part.properties, `pipe ${itemIndex} part properties`), diameter: nullableMeasure(part.diameter, `pipe ${itemIndex} diameter`) ?? undefined, span: nullableMeasure(part.span, `pipe ${itemIndex} span`) ?? undefined, width: nullableMeasure(part.width, `pipe ${itemIndex} width`) ?? undefined, height: nullableMeasure(part.height, `pipe ${itemIndex} height`) ?? undefined, thickness: nullableMeasure(part.thickness, `pipe ${itemIndex} thickness`) ?? undefined, material: nullableString(part.material, `pipe ${itemIndex} material`) }, geometry: { kind: geometryKind, point: geometry.point === null || geometry.point === undefined ? null : pipePosition(geometry.point, `pipe ${itemIndex} route point`) }, length: nullableMeasure(pipe.length, `pipe ${itemIndex} length`), flow: flow(pipe.flow, `pipe ${itemIndex} flow`) };
      }),
    };
  });
  const schema = string(raw.schema, 'pipe network schema');
  if (!isLandXmlSchema(schema)) throw new Error('LandXML WASM returned an invalid pipe network schema');
  const capabilityDiagnostics = array(raw.capability_diagnostics, 'pipe network capability diagnostics')
    .map((value, index): LandXmlCapabilityDiagnostic => {
      const diagnostic = record(value, `pipe network capability diagnostic ${index}`);
      return {
        code: string(diagnostic.code, `pipe network capability diagnostic ${index} code`),
        sourceId: nullableString(diagnostic.source_id, `pipe network capability diagnostic ${index} source id`),
        sourcePath: string(diagnostic.source_path, `pipe network capability diagnostic ${index} source path`),
        message: string(diagnostic.message, `pipe network capability diagnostic ${index} message`),
      };
    });
  return { schema, version: string(raw.version, 'pipe network version'), capabilityDiagnostics, rootUnits: raw.root_units === null || raw.root_units === undefined ? null : pipeUnits(raw.root_units, 'pipe root units'), collections: array(raw.collections, 'pipe collections').map((value, index) => { const collection = record(value, `pipe collection ${index}`); return { sourceId: string(collection.source_id, `pipe collection ${index} source id`), sourcePath: string(collection.source_path, `pipe collection ${index} source path`), properties: properties(collection.properties, `pipe collection ${index} properties`) }; }), networks, features: array(raw.features, 'pipe features').map((item, index) => feature(item, `pipe feature ${index}`)), refusals: array(raw.refusals, 'pipe refusals').map((value, index) => { const item = record(value, `pipe refusal ${index}`); return { sourceId: string(item.source_id, `pipe refusal ${index} source id`), sourcePath: string(item.source_path, `pipe refusal ${index} source path`), code: string(item.code, `pipe refusal ${index} code`), message: string(item.message, `pipe refusal ${index} message`) }; }) };
}
