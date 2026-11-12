/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Hand-built, non-IFCX tables for the `buildTabularDataStore` tests. */

import {
  EntityTableBuilder,
  PropertyTableBuilder,
  PropertyValueType,
  QuantityTableBuilder,
  QuantityType,
  RelationshipGraphBuilder,
  StringTable,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';

import { buildTabularDataStore, type TabularStoreTables } from '@/hooks/ingest/tabularDataStore.js';

export const PROXY_A = 1;
export const PROXY_B = 2;
export const WALL = 3;

export function tabularFixtureTables(): TabularStoreTables {
  const strings = new StringTable();

  const entities = new EntityTableBuilder(3, strings);
  entities.add(PROXY_A, 'IfcBuildingElementProxy', '0aBcDeFgHiJkLmNoPqRs01', 'Object A', '', '', true);
  entities.add(PROXY_B, 'IfcBuildingElementProxy', '0aBcDeFgHiJkLmNoPqRs02', 'Object B', '', '', true);
  entities.add(WALL, 'IfcWall', '0aBcDeFgHiJkLmNoPqRs03', 'Wall C', '', '', true);

  const properties = new PropertyTableBuilder(strings);
  for (const [propName, value] of [['Supplier', 'Acme'], ['Phase', 'Shell']]) {
    properties.add({
      entityId: PROXY_A, psetName: 'Attribute User Text', psetGlobalId: '',
      propName, propType: PropertyValueType.Label, value,
    });
  }

  const quantities = new QuantityTableBuilder(strings);
  quantities.add({
    entityId: WALL, qsetName: 'Qto_WallBaseQuantities',
    quantityName: 'Length', quantityType: QuantityType.Length, value: 4200,
  });
  quantities.add({
    entityId: WALL, qsetName: 'Qto_WallBaseQuantities',
    quantityName: 'NetVolume', quantityType: QuantityType.Volume, value: 2.52,
  });

  return {
    strings,
    entities: entities.build(),
    properties: properties.build(),
    quantities: quantities.build(),
    relationships: new RelationshipGraphBuilder().build(),
  };
}

/** Millimetres the file declares, under an IFC4 label: nothing here is IFCX's. */
export function tabularFixtureStore(): IfcDataStore {
  return buildTabularDataStore(tabularFixtureTables(), {
    schemaVersion: 'IFC4',
    source: new ArrayBuffer(0),
    fileSize: 4096,
    entityCount: 3,
    parseTime: 12,
    lengthUnitScale: 0.001,
    lengthUnitSource: 'declared',
  });
}
