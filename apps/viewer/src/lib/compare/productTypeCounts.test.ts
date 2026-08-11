/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DiffEntry, DiffState } from '@ifc-lite/diff';
import { groupHeaderCount, hasTypeObjectChanges, productTypeSplit } from './productTypeCounts.js';
import type { CompareRef } from './buildFingerprints.js';

function entry(
  state: DiffState,
  ifcType: string,
  key: string,
): DiffEntry<CompareRef> {
  const fp = {
    key,
    ifcType,
    dataHash: 'd',
    ref: { modelId: 'a', localId: 1, globalId: 1 },
  };
  return {
    key,
    state,
    changeKinds: state === 'modified' ? ['data'] : [],
    base: state === 'added' ? undefined : fp,
    head: state === 'deleted' ? undefined : fp,
  };
}

describe('productTypeSplit', () => {
  it('splits a mixed result: product changes AND type-object changes (certification pair shape)', () => {
    // Shape of the reported confusion: 1 added, 2 deleted, 26 modified
    // products, plus 4 modified IfcBuildingElementProxyType type objects.
    const entries: DiffEntry<CompareRef>[] = [
      entry('added', 'IfcWall', 'p-add-1'),
      entry('deleted', 'IfcDoor', 'p-del-1'),
      entry('deleted', 'IfcWindow', 'p-del-2'),
      ...Array.from({ length: 26 }, (_, i) => entry('modified', 'IfcWall', `p-mod-${i}`)),
      ...Array.from({ length: 4 }, (_, i) =>
        entry('modified', 'IfcBuildingElementProxyType', `t-mod-${i}`),
      ),
    ];

    const split = productTypeSplit(entries);
    assert.deepStrictEqual(split.products, { added: 1, modified: 26, deleted: 2 });
    assert.deepStrictEqual(split.typeObjects, { added: 0, modified: 4, deleted: 0 });
    assert.strictEqual(hasTypeObjectChanges(split), true);
  });

  it('classifies an IFC2X3 style-named type object correctly (not by name, by chain)', () => {
    // IfcDoorStyle/IfcWindowStyle are IfcTypeObject subtypes whose names do not
    // end in "Type" - a name-based classifier would misfile them as products.
    const entries: DiffEntry<CompareRef>[] = [entry('modified', 'IfcDoorStyle', 'ds-1')];
    const split = productTypeSplit(entries);
    assert.deepStrictEqual(split.typeObjects, { added: 0, modified: 1, deleted: 0 });
    assert.deepStrictEqual(split.products, { added: 0, modified: 0, deleted: 0 });
  });

  it('classifies an IFC4X3-only type object correctly (the pin trap)', () => {
    // The parser's IFC4 codegen pin answers an empty inheritance chain for
    // IFC4X3-only classes; the classifier must use the cross-schema chain, not
    // the pin, or this row silently mis-buckets as a product.
    const entries: DiffEntry<CompareRef>[] = [entry('modified', 'IfcSignalType', 'sig-1')];
    const split = productTypeSplit(entries);
    assert.deepStrictEqual(split.typeObjects, { added: 0, modified: 1, deleted: 0 });
  });

  it('keeps a vendor-extension class in the headline product count (review find)', () => {
    // A proprietary exporter's class that no bundled schema declares: the
    // geometry pass may well have meshed it, and the user is grading its
    // changes. Only a POSITIVE IfcTypeObject proof may subtract a row from the
    // primary number — "not provably a product" must not silently demote it
    // to the "+N type objects" hint.
    const entries: DiffEntry<CompareRef>[] = [entry('modified', 'IfcVendorSpecialPipe', 'v-1')];
    const split = productTypeSplit(entries);
    assert.deepStrictEqual(split.products, { added: 0, modified: 1, deleted: 0 });
    assert.deepStrictEqual(split.typeObjects, { added: 0, modified: 0, deleted: 0 });
  });

  it('counts a spatial product (IfcSite) as a product, not a type object', () => {
    const entries: DiffEntry<CompareRef>[] = [entry('modified', 'IfcSite', 'site-1')];
    const split = productTypeSplit(entries);
    assert.deepStrictEqual(split.products, { added: 0, modified: 1, deleted: 0 });
    assert.deepStrictEqual(split.typeObjects, { added: 0, modified: 0, deleted: 0 });
  });

  it('ignores unchanged entries entirely', () => {
    const entries: DiffEntry<CompareRef>[] = [entry('unchanged', 'IfcWall', 'u-1')];
    const split = productTypeSplit(entries);
    assert.deepStrictEqual(split.products, { added: 0, modified: 0, deleted: 0 });
    assert.deepStrictEqual(split.typeObjects, { added: 0, modified: 0, deleted: 0 });
  });

  it('the empty case: no type-object changes reports hasTypeObjectChanges === false', () => {
    const entries: DiffEntry<CompareRef>[] = [entry('modified', 'IfcWall', 'w-1')];
    const split = productTypeSplit(entries);
    assert.strictEqual(hasTypeObjectChanges(split), false);
  });
});

describe('groupHeaderCount (review find: two totals for one quantity in one panel)', () => {
  it('shows products with the badge-identical type-object remainder', () => {
    const entries: DiffEntry<CompareRef>[] = [
      ...Array.from({ length: 26 }, (_, i) => entry('modified', 'IfcWall', `p-${i}`)),
      ...Array.from({ length: 4 }, (_, i) =>
        entry('modified', 'IfcBuildingElementProxyType', `t-${i}`),
      ),
    ];
    // The motivating case: badge "26 Changed / +4 type objects" above a header
    // that read "Changed (30)". The header must agree with the badge.
    assert.strictEqual(groupHeaderCount(productTypeSplit(entries), 'modified'), '26 +4 type objects');
  });

  it('renders exactly the plain count when there is no type-object remainder', () => {
    const entries: DiffEntry<CompareRef>[] = [entry('added', 'IfcWall', 'p-1')];
    assert.strictEqual(groupHeaderCount(productTypeSplit(entries), 'added'), '1');
  });
});
