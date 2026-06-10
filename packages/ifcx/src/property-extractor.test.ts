/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable } from '@ifc-lite/data';
import { extractProperties } from './property-extractor.js';
import type { ComposedNode } from './types.js';

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
});
