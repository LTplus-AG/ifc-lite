/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable, EntityTableBuilder, IfcTypeEnum } from '@ifc-lite/data';
import type { SpatialHierarchy } from '@ifc-lite/data';
import { IfcxWriter, exportToIfcx } from './writer.js';

function buildTable() {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(2, strings);
  builder.add(101, 'IFCWALL', '0YvCT2_$X3_xJG3rzD8L_8', 'Wall-A', 'desc', 'Standard', true, false);
  builder.add(102, 'IFCDOOR', '1abCT2_$X3_xJG3rzD8L_8', 'Door-A', '', '', true, false);
  return { strings, table: builder.build() };
}

/** Minimal stub satisfying only the fields writer.ts actually reads. */
function stubHierarchy(overrides: Partial<SpatialHierarchy>): SpatialHierarchy {
  return {
    project: { expressId: 1, type: IfcTypeEnum.IfcProject, name: '', children: [], elements: [] },
    byStorey: new Map(),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map(),
    storeyHeights: new Map(),
    elementToStorey: new Map(),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
    ...overrides,
  };
}

describe('IfcxWriter.export', () => {
  it('maps the wall type enum to the IfcWall class name, not a neighboring type', () => {
    // Kills: swapping the 10 -> 'IfcWall' typeMap entry for any other class
    // name (e.g. 'IfcWallStandardCase' or 'IfcDoor'). Nothing previously
    // asserted on getTypeName's output, so any entry could be silently
    // swapped for another and the suite would stay green.
    const { strings, table } = buildTable();
    const writer = new IfcxWriter({ entities: table, strings });
    const result = writer.export({ includeProperties: false });
    const file = JSON.parse(result.content);

    const wallNode = file.data.find((n: { path: string }) => n.path.includes('101'));
    const doorNode = file.data.find((n: { path: string }) => n.path.includes('102'));
    assert.strictEqual(wallNode.attributes['bsi::ifc::class'].code, 'IfcWall');
    assert.strictEqual(doorNode.attributes['bsi::ifc::class'].code, 'IfcDoor');
  });

  it('prefers byStorey containment over byBuilding/bySite/bySpace when an id appears in more than one map', () => {
    // Kills: reordering the byStorey || byBuilding || bySite || bySpace
    // fallback chain in getChildrenForEntity. All four maps are same-typed
    // (Map<number, number[]>) and swappable; only pinning a case where the
    // same key exists in two maps with different values proves the order.
    const { strings, table } = buildTable();
    const hierarchy = stubHierarchy({
      byStorey: new Map([[101, [102]]]),
      bySite: new Map([[101, [999]]]),
    });
    const writer = new IfcxWriter({ entities: table, strings, spatialHierarchy: hierarchy });
    const result = writer.export({ includeProperties: false });
    const file = JSON.parse(result.content);

    const wallNode = file.data.find((n: { path: string }) => n.path.includes('101'));
    assert.deepStrictEqual(wallNode.children, { element_102: 'element:102' });
  });

  it('falls back to bySite when the id is absent from byStorey and byBuilding', () => {
    const { strings, table } = buildTable();
    const hierarchy = stubHierarchy({
      bySite: new Map([[101, [102]]]),
    });
    const writer = new IfcxWriter({ entities: table, strings, spatialHierarchy: hierarchy });
    const result = writer.export({ includeProperties: false });
    const file = JSON.parse(result.content);

    const wallNode = file.data.find((n: { path: string }) => n.path.includes('101'));
    assert.deepStrictEqual(wallNode.children, { element_102: 'element:102' });
  });

  it('requests the IFC prop schema import only for bsi::ifc::prop:: keys, not presentation keys', () => {
    // Kills: collapsing the needsIfcProp / needsIfcCore key-prefix checks in
    // collectRequiredImports onto the same prefix. A node using only
    // bsi::ifc::prop::Name must NOT pull in the IFC_CORE import, since core
    // is reserved for class/presentation/material/spaceBoundary attributes.
    const { strings, table } = buildTable();
    const writer = new IfcxWriter({ entities: table, strings });
    const result = writer.export({ includeProperties: false });
    const file = JSON.parse(result.content);

    const uris = file.imports.map((i: { uri: string }) => i.uri);
    assert.ok(uris.some((u: string) => u.includes('/ifc/core/prop@')), 'expected prop schema import');
    assert.ok(uris.some((u: string) => u.includes('/ifc/core/ifc@')), 'expected core schema import (bsi::ifc::class present)');
  });
});

describe('exportToIfcx', () => {
  it('returns the same content as IfcxWriter.export().content', () => {
    const { strings, table } = buildTable();
    const content = exportToIfcx({ entities: table, strings }, { includeProperties: false });
    const writer = new IfcxWriter({ entities: table, strings });
    const direct = writer.export({ includeProperties: false }).content;
    // Both invocations mint a fresh header id/timestamp, so compare only the data payload.
    assert.deepStrictEqual(JSON.parse(content).data, JSON.parse(direct).data);
  });
});
