/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Server↔client parity for TYPE-level properties/QTOs and the Type column
 * (issues #1751 / #1754).
 *
 * The same IFC file is executed through both parse paths and the Lists results
 * are asserted DEEP-EQUAL:
 *  - CLIENT: the in-browser WASM/columnar parse (`IfcParser.parseColumnar`).
 *  - SERVER: `convertServerDataModel` over a DataModel shaped exactly like the
 *    Rust server emits (verified independently by the Rust test
 *    `extracts_type_relationship_and_resolves_typed_property_values`): typed
 *    property values already resolved to canonical string + kind + data_type,
 *    an IfcRelDefinesByType edge, and synthetic TYPEHASPROPERTYSETS edges for
 *    the type's HasPropertySets.
 *
 * Grouping + per-group sums are included so a regression where server numeric
 * properties stay strings (they wouldn't sum) fails loudly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList, type ListDefinition } from '@ifc-lite/lists';
import type { DataModel } from '@ifc-lite/server-client';
import { createListDataProvider } from './adapter';
import { convertServerDataModel, type ServerParseResult } from '../../utils/serverDataModel';

// IfcWallType with HasPropertySets (string / boolean / real / integer) + a Qto,
// two walls via IfcRelDefinesByType, one instance pset overriding FireRating.
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('Wall00000000000000001A',$,'W-A','South wall','Basic Wall',$,$,'T-100',.SOLIDWALL.);
#110=IFCWALL('Wall00000000000000001B',$,'W-B',$,$,$,$,$,.PARTITIONING.);
#200=IFCWALLTYPE('Type00000000000000001A',$,'WT-Std',$,'NotObjectType',(#210,#220),$,$,$,.STANDARD.);
#300=IFCSITE('Site000000000000000001A',$,'S','site desc',$,$,$,'LONG-NAME',.ELEMENT.,$,$,$,$,$);
#210=IFCPROPERTYSET('Pset00000000000000001A',$,'Pset_WallCommon',$,(#211,#212,#213,#214,#215));
#211=IFCPROPERTYSINGLEVALUE('Manufacturer',$,IFCLABEL('ACME'),$);
#212=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#213=IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCREAL(0.24),$);
#214=IFCPROPERTYSINGLEVALUE('Layers',$,IFCINTEGER(3),$);
#215=IFCPROPERTYENUMERATEDVALUE('AcousticRating',$,(IFCLABEL('R1'),IFCLABEL('R2')),$);
#220=IFCELEMENTQUANTITY('Qset00000000000000001A',$,'Qto_WallBaseQuantities',$,$,(#221));
#221=IFCQUANTITYLENGTH('Width',$,$,200.);
#230=IFCRELDEFINESBYTYPE('Rdbt00000000000000001A',$,$,$,(#100,#110),#200);
#250=IFCPROPERTYSET('Pset00000000000000002A',$,'Pset_WallCommon',$,(#251));
#251=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 120'),$);
#260=IFCRELDEFINESBYPROPERTIES('Rdbp00000000000000001A',$,$,$,(#100),#250);
ENDSEC;
END-ISO-10303-21;
`;

/** DataModel exactly as the Rust server emits it for FIXTURE (values already
 *  resolved; DefinesByType + TYPEHASPROPERTYSETS edges present). */
function serverDataModelForFixture(): DataModel {
  return {
    entities: new Map([
      [1, { entity_id: 1, type_name: 'IFCPROJECT', global_id: 'Proj0000000000000000001', name: 'P', has_geometry: false }],
      [100, { entity_id: 100, type_name: 'IFCWALL', global_id: 'Wall00000000000000001A', name: 'W-A', description: 'South wall', object_type: 'Basic Wall', tag: 'T-100', predefined_type: 'SOLIDWALL', has_geometry: false }],
      [110, { entity_id: 110, type_name: 'IFCWALL', global_id: 'Wall00000000000000001B', name: 'W-B', predefined_type: 'PARTITIONING', has_geometry: false }],
      [200, { entity_id: 200, type_name: 'IFCWALLTYPE', global_id: 'Type00000000000000001A', name: 'WT-Std', predefined_type: 'STANDARD', has_geometry: false }],
      [300, { entity_id: 300, type_name: 'IFCSITE', global_id: 'Site000000000000000001A', name: 'S', description: 'site desc', has_geometry: false }],
    ]),
    propertySets: new Map([
      [210, { pset_id: 210, pset_name: 'Pset_WallCommon', properties: [
        { property_name: 'Manufacturer', property_value: 'ACME', property_type: 'string', data_type: 'IFCLABEL' },
        { property_name: 'IsExternal', property_value: 'true', property_type: 'boolean', data_type: 'IFCBOOLEAN' },
        { property_name: 'ThermalTransmittance', property_value: '0.24', property_type: 'real', data_type: 'IFCREAL' },
        { property_name: 'Layers', property_value: '3', property_type: 'integer', data_type: 'IFCINTEGER' },
        { property_name: 'AcousticRating', property_value: 'R1, R2', property_type: 'string' },
      ] }],
      [250, { pset_id: 250, pset_name: 'Pset_WallCommon', properties: [
        { property_name: 'FireRating', property_value: 'REI 120', property_type: 'string', data_type: 'IFCLABEL' },
      ] }],
    ]),
    quantitySets: new Map([
      [220, { qset_id: 220, qset_name: 'Qto_WallBaseQuantities', quantities: [
        { quantity_name: 'Width', quantity_value: 200, quantity_type: 'length' },
      ] }],
    ]),
    relationships: [
      { rel_type: 'IFCRELDEFINESBYTYPE', relating_id: 200, related_id: 100 },
      { rel_type: 'IFCRELDEFINESBYTYPE', relating_id: 200, related_id: 110 },
      { rel_type: 'IFCRELDEFINESBYPROPERTIES', relating_id: 250, related_id: 100 },
      { rel_type: 'TYPEHASPROPERTYSETS', relating_id: 210, related_id: 200 },
      { rel_type: 'TYPEHASPROPERTYSETS', relating_id: 220, related_id: 200 },
    ],
    spatialHierarchy: {
      nodes: [
        { entity_id: 1, parent_id: 0, level: 0, path: 'P', type_name: 'IFCPROJECT', name: 'P', children_ids: [], element_ids: [] },
      ],
      project_id: 1,
      element_to_storey: new Map(),
      element_to_building: new Map(),
      element_to_site: new Map(),
      element_to_space: new Map(),
    },
  } as unknown as DataModel;
}

const DEFINITION: ListDefinition = {
  id: 'parity', name: 'Parity', createdAt: 0, updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall],
  conditions: [],
  columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' },
    { id: 'type', source: 'attribute', propertyName: 'Type' },
    { id: 'mfr', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'Manufacturer' },
    { id: 'ext', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'IsExternal' },
    { id: 'u', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'ThermalTransmittance' },
    { id: 'layers', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'Layers' },
    { id: 'ar', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'AcousticRating' },
    { id: 'fr', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' },
    { id: 'w', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Width' },
    { id: 'desc', source: 'attribute', propertyName: 'Description' },
    { id: 'objt', source: 'attribute', propertyName: 'ObjectType' },
    { id: 'pdt', source: 'attribute', propertyName: 'PredefinedType' },
    { id: 'tag', source: 'attribute', propertyName: 'Tag' },
  ],
  grouping: { columnId: 'type', sumColumnIds: ['u', 'w'] },
};

const parseResult: ServerParseResult = {
  cache_key: 'parity', metadata: { schema_version: 'IFC4' },
  stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
};

describe('server↔client Type parity (#1751/#1754)', () => {
  it('produces identical Lists results on both parse paths', async () => {
    // CLIENT (WASM/columnar) path.
    const bytes = new TextEncoder().encode(FIXTURE);
    const clientStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const clientResult = executeList(DEFINITION, createListDataProvider(clientStore));

    // SERVER path.
    const serverStore = convertServerDataModel(serverDataModelForFixture(), parseResult, { size: FIXTURE.length }, []);
    const serverResult = executeList(DEFINITION, createListDataProvider(serverStore));

    // Row cell values, ordered by Name for a stable compare.
    const byName = (r: { values: unknown[] }[]) =>
      [...r].sort((a, b) => String(a.values[0]).localeCompare(String(b.values[0]))).map((row) => row.values);
    assert.deepEqual(byName(serverResult.rows), byName(clientResult.rows), 'row cell values diverge across parse paths');

    // Sanity: the type-inherited + override values actually resolved (not blank).
    const rowsByName = new Map(clientResult.rows.map((r) => [String(r.values[0]), r.values]));
    assert.deepEqual(rowsByName.get('W-A'), ['W-A', 'WT-Std', 'ACME', 'True', 0.24, 3, 'R1, R2', 'REI 120', 200, 'South wall', 'Basic Wall', 'SOLIDWALL', 'T-100']);
    assert.deepEqual(rowsByName.get('W-B'), ['W-B', 'WT-Std', 'ACME', 'True', 0.24, 3, 'R1, R2', null, 200, null, null, 'PARTITIONING', null]);

    // Column meta (quantityType / dataType) identical — drives unit conversion.
    assert.deepEqual(
      serverResult.columns.map((c) => [c.id, c.quantityType ?? null, c.dataType ?? null]),
      clientResult.columns.map((c) => [c.id, c.quantityType ?? null, c.dataType ?? null]),
      'column unit metadata diverges',
    );

    // Group sums identical (proves server numeric props are real numbers).
    assert.deepEqual(serverResult.summary?.sums, clientResult.summary?.sums, 'group sums diverge');
    assert.equal(serverResult.summary?.sums['w'], 400); // 200 + 200
    assert.ok(Math.abs((serverResult.summary?.sums['u'] ?? 0) - 0.48) < 1e-9); // 0.24 + 0.24
  });
});
