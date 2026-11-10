/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Narrow writer interfaces keep this wire fixture independent of vendor declaration shims.
const arrow: { tableFromArrays(columns: Record<string, unknown>): unknown; tableToIPC(table: unknown): Uint8Array } = require('apache-arrow');
const parquet: { Table: { fromIPCStream(bytes: Uint8Array): unknown }; writeParquet(table: unknown): Uint8Array } = require('parquet-wasm');
const table = (columns: Record<string, unknown>) => parquet.writeParquet(parquet.Table.fromIPCStream(arrow.tableToIPC(arrow.tableFromArrays(columns))));
function sections(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + 4 + part.length, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  for (const part of parts) { view.setUint32(offset, part.length, true); offset += 4; bytes.set(part, offset); offset += part.length; }
  return bytes;
}
/** Real, tiny server wire payload: one named wall, one project, and one property. */
export function propertyModelBuffer(): ArrayBuffer {
  const entities = table({ entity_id: new Uint32Array([1, 2]), has_geometry: new Uint8Array([1, 0]), type_name: ['IfcWall', 'IfcProject'], global_id: ['wall', 'project'], name: ['Server properties', 'Project'] });
  const properties = table({ pset_id: new Uint32Array([10]), pset_name: ['Pset_WallCommon'], property_name: ['IsExternal'], property_value: ['true'], property_type: ['IfcPropertySingleValue'], data_type: ['boolean'] });
  const quantities = table({ qset_id: new Uint32Array([11]), qset_name: ['Qto_WallBaseQuantities'], method_of_measurement: [''], quantity_name: ['Length'], quantity_value: new Float64Array([1]), quantity_type: ['IfcQuantityLength'] });
  const relationships = table({ rel_type: ['IfcRelAggregates', 'IfcRelDefinesByProperties'], relating_id: new Uint32Array([2, 10]), related_id: new Uint32Array([1, 1]) });
  const nodes = table({ entity_id: new Uint32Array([2]), parent_id: new Uint32Array([0]), level: new Uint16Array([0]), path: ['/2'], type_name: ['IfcProject'], name: ['Project'], elevation: new Float64Array([0]) });
  const lookup = table({ element_id: new Uint32Array([1]), spatial_id: new Uint32Array([2]) });
  const spatialSections = sections([nodes, lookup, lookup, lookup, lookup]);
  const spatial = new Uint8Array(spatialSections.length + 4); spatial.set(spatialSections);
  new DataView(spatial.buffer).setUint32(spatialSections.length, 2, true);
  const buffer = sections([entities, properties, quantities, relationships, spatial]);
  const result = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(result).set(buffer);
  return result;
}
