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
