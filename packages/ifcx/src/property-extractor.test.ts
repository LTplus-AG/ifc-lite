/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable } from '@ifc-lite/data';
import { parseIfcx } from './index.js';
import { extractProperties } from './property-extractor.js';
import type { ComposedNode, IfcxFile } from './types.js';

function createNode(path: string): ComposedNode {
  return {
    path,
    attributes: new Map(),
    children: new Map(),
  };
}

function extract(node: ComposedNode): Array<{ name: string; value: unknown }> {
  const composed = new Map([[node.path, node]]);
  const pathToId = new Map([[node.path, 1]]);
  const table = extractProperties(composed, pathToId, new StringTable());
  return table.getForEntity(1).flatMap((pset) => pset.properties);
}

describe('extractProperties — typed records and internal carriers (#1031)', () => {
  it('decodes TypedPropertyValue records to their scalar value', () => {
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::v5a::Pset_FireSafety::FireRating', {
      type: 'IfcLabel',
      value: 'F30',
      source: 'manual',
    });

    const props = extract(node);
    const fireRating = props.find((p) => p.name === 'FireRating');
    assert.ok(fireRating, 'FireRating extracted');
    // The actual scalar, not a JSON blob of the record.
    assert.strictEqual(fireRating.value, 'F30');
  });

  it('skips ifclite:: carrier attributes entirely', () => {
    const node = createNode('wall');
    node.attributes.set('ifclite::classifications', [{ system: 'eBKP-H', code: 'C2.1' }]);
    node.attributes.set('ifclite::materials', [{ materialId: 'mat-1' }]);
    node.attributes.set('ifclite::geometryRef', 'geom-1');
    node.attributes.set('ifclite::deleted', false);
    node.attributes.set('bsi::ifc::v5a::Pset_WallCommon::IsExternal', {
      type: 'IfcBoolean',
      value: true,
    });

    const props = extract(node);
    assert.strictEqual(props.length, 1, 'only the real property surfaces');
    assert.strictEqual(props[0].name, 'IsExternal');
    assert.strictEqual(props[0].value, true);
  });

  it('leaves raw scalar attributes untouched (legacy migrated values)', () => {
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::v5a::Pset_WallCommon::FireRating', 'F30');

    const props = extract(node);
    const fireRating = props.find((p) => p.name === 'FireRating');
    assert.ok(fireRating);
    assert.strictEqual(fireRating.value, 'F30');
  });

  it('quantity-named Pset_* members stay properties (namespace wins over name heuristic)', () => {
    const node = createNode('wall');
    node.attributes.set('bsi::ifc::v5a::Pset_Dimensions::Length', { type: 'IfcReal', value: 2 });
    node.attributes.set('bsi::ifc::v5a::Pset_Dimensions::Area', 4.5);

    const props = extract(node);
    const length = props.find((p) => p.name === 'Length');
    assert.ok(length, 'Length stays in the property table');
    assert.strictEqual(length.value, 2);
    const area = props.find((p) => p.name === 'Area');
    assert.ok(area, 'raw-number Area stays in the property table too');
    assert.strictEqual(area.value, 4.5);
  });

  it('custom v5a sets mirror the collab dialect: typed → property, raw number → quantity', async () => {
    const file: IfcxFile = {
      header: {
        id: 'custom-sets',
        ifcxVersion: 'ifcx-alpha',
        dataVersion: '1',
        author: 'test',
        timestamp: '2026-06-10T00:00:00Z',
      },
      imports: [],
      schemas: {},
      data: [
        {
          path: 'wall',
          attributes: {
            'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
            // Custom pset with a quantity-LIKE name: typed record → stays
            // a property (collab inflation puts it in psets).
            'bsi::ifc::v5a::Dimensions::Length': { type: 'IfcReal', value: 2 },
            // Custom quantity set with a non-heuristic name: raw number →
            // quantity (collab inflation puts it in quantities).
            'bsi::ifc::v5a::CarbonMetrics::EmbodiedCO2': 412.5,
          },
        },
      ],
    };
    const buffer = new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer;
    const result = await parseIfcx(buffer);

    const props = result.properties.getForEntity(1).flatMap((pset) => pset.properties);
    const length = props.find((p) => p.name === 'Length');
    assert.ok(length, 'typed Length stays a property');
    assert.strictEqual(length.value, 2);
    assert.ok(!props.some((p) => p.name === 'EmbodiedCO2'), 'raw custom quantity not a property');

    const qsets = result.quantities.getForEntity(1);
    const co2Set = qsets.find((qset) => qset.name === 'CarbonMetrics');
    assert.ok(co2Set, `authored custom set name kept (got ${JSON.stringify(qsets.map((q) => q.name))})`);
    const co2 = co2Set.quantities.find((q) => q.name === 'EmbodiedCO2');
    assert.ok(co2, 'raw custom quantity reaches the quantity table');
    assert.strictEqual(co2.value, 412.5);
    assert.ok(
      !qsets.some((qset) => qset.quantities.some((q) => q.name === 'Length')),
      'typed Length not double-claimed as quantity'
    );
  });

  it('typed quantity-like properties land in the quantity table, not dropped', async () => {
    const file: IfcxFile = {
      header: {
        id: 'typed-qty',
        ifcxVersion: 'ifcx-alpha',
        dataVersion: '1',
        author: 'test',
        timestamp: '2026-06-10T00:00:00Z',
      },
      imports: [],
      schemas: {},
      data: [
        {
          path: 'wall',
          attributes: {
            'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
            // Quantity-like name with a typed record (#1031): must be
            // routed to the QuantityTable, not vanish from both tables.
            'bsi::ifc::v5a::Qto_WallBaseQuantities::NetArea': { type: 'IfcReal', value: 12.5 },
          },
        },
      ],
    };
    const buffer = new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer;
    const result = await parseIfcx(buffer);

    const entityId = 1; // single entity
    const qsets = result.quantities.getForEntity(entityId);
    const all = qsets.flatMap((qset) => qset.quantities);
    const netArea = all.find((q) => q.name === 'NetArea');
    assert.ok(netArea, `NetArea present in quantity table (got ${JSON.stringify(qsets)})`);
    assert.strictEqual(netArea.value, 12.5);
  });
});
