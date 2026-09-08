/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model loaded from the server must export the class its STEP line declares,
 * exactly as a locally parsed one does.
 *
 * `buildEntityTable` interns the server's class string into `rawTypeName`
 * (#3322), so the exact name is present in the table. Without a
 * `getExactTypeName` accessor beside it, `exactTypeName()` falls through to
 * `getTypeName` — which resolves through `IfcTypeEnum` and answers the
 * coalesced family name. The exact class is then discarded from the Parquet
 * `Type` column while sitting in the array the same table exposes.
 *
 * Checked in both directions against a NAMED class list: every declared class
 * must appear on its own row, and no row may carry a class other than the one
 * its STEP line declared. A count cannot see this defect — it swaps classes
 * without changing any count.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';
import { ParquetExporter } from '@ifc-lite/export';
// `apps/viewer/src/apache-arrow.d.ts` declares this module with `export =`,
// so the named import the packages/export tests use does not type-check here.
import * as arrow from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { convertServerDataModel, type ServerParseResult } from './serverDataModel';

const parseResult: ServerParseResult = {
  cache_key: 'exact-type',
  metadata: { schema_version: 'IFC4' },
  stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
};

/**
 * expressId → the class the server declared, named one by one. `IfcTypeEnum`
 * coalesces four of these onto another class's value on purpose; the last
 * (`IfcSanitaryTerminal`) has no enum value at all, so it reaches the exact
 * path from the other side, and `IfcWallStandardCase` survives only because it
 * happens to hold its own enum value.
 */
const ROWS: ReadonlyArray<readonly [number, string, string]> = [
  [1, 'IFCPROJECT', 'IfcProject'],
  [2, 'IFCDOOR', 'IfcDoor'],
  [3, 'IFCDOORSTANDARDCASE', 'IfcDoorStandardCase'],
  [4, 'IFCWALLSTANDARDCASE', 'IfcWallStandardCase'],
  [5, 'IFCWALL', 'IfcWall'],
  [6, 'IFCDISTRIBUTIONELEMENT', 'IfcDistributionElement'],
  [7, 'IFCDISTRIBUTIONFLOWELEMENT', 'IfcDistributionFlowElement'],
  [8, 'IFCDISTRIBUTIONCONTROLELEMENT', 'IfcDistributionControlElement'],
  [9, 'IFCSLABSTANDARDCASE', 'IfcSlabStandardCase'],
  [10, 'IFCSANITARYTERMINAL', 'IfcSanitaryTerminal'],
];

/**
 * The rows whose enum answer differs from their declared class — the
 * anti-vacuity guard. If this list stops diverging the fixture has stopped
 * reproducing the defect and everything above it passes for the wrong reason.
 */
const COALESCED: ReadonlyArray<readonly [number, string]> = [
  [3, 'IfcDoor'],
  [7, 'IfcDistributionElement'],
  [8, 'IfcDistributionElement'],
  [9, 'IfcSlab'],
];

/** A class no IFC schema declares: it must degrade, never acquire an invented name. */
const UNKNOWN_CLASS = { id: 11, raw: 'IFCNOTATHINGATALL' };

function dataModel(): DataModel {
  return {
    entities: ServerEntityIndex.fromRows(
      [...ROWS.map(([id, raw]) => ({ id, raw })), UNKNOWN_CLASS].map((r, i) => ({
        entity_id: r.id,
        type_name: r.raw,
        global_id: `G${i}`.padEnd(22, 'x'),
        name: `E${r.id}`,
        has_geometry: false,
      })),
    ),
    propertySets: new Map(),
    quantitySets: new Map(),
    relationships: [],
    classifications: [],
    materials: [],
    documents: [],
    spatialHierarchy: {
      nodes: [
        {
          entity_id: 1,
          parent_id: 0,
          level: 0,
          path: 'P',
          type_name: 'IFCPROJECT',
          name: 'E1',
          children_ids: [],
          element_ids: [...ROWS.slice(1).map(([id]) => id), UNKNOWN_CLASS.id],
        },
      ],
      project_id: 1,
      element_to_storey: new Map(),
      element_to_building: new Map(),
      element_to_site: new Map(),
      element_to_space: new Map(),
    },
  } as unknown as DataModel;
}

function store() {
  return convertServerDataModel(dataModel(), parseResult, { size: 1 }, []);
}

function decode(bytes: Uint8Array): Record<string, unknown>[] {
  const table = arrow.tableFromIPC(readParquet(bytes).intoIPCStream());
  return (table.toArray() as { toJSON(): Record<string, unknown> }[]).map((row) => row.toJSON());
}

describe('Parquet export off a server-hydrated store', () => {
  it('anti-vacuity: the coalesced fixture rows really do diverge from their declared class', () => {
    const s = store();
    assert.ok(COALESCED.length > 0, 'fixture must contain at least one coalesced class');
    for (const [id, coalesced] of COALESCED) {
      const declared = ROWS.find(([e]) => e === id)?.[2];
      assert.ok(declared, `#${id} missing from ROWS`);
      assert.notEqual(coalesced, declared, `#${id} must actually diverge`);
      assert.equal(s.entities.getTypeName(id), coalesced, `#${id} getTypeName must still coalesce`);
    }
    // And the exact name really is in the table's own array, not merely derivable.
    for (const [id, , declared] of ROWS) {
      const idx = (s.entities.expressId as Uint32Array).indexOf(id);
      assert.ok(idx >= 0, `#${id} absent from the table`);
      assert.equal(
        s.strings.get(s.entities.rawTypeName![idx]),
        declared,
        `#${id} rawTypeName must hold the declared class`,
      );
    }
  });

  it('names each declared class in the Type column, and never another class in its place', async () => {
    const rows = decode(await new ParquetExporter(store()).exportTable('entities'));
    const byId = new Map<number, string>(rows.map((r) => [Number(r.ExpressId), String(r.Type)]));

    // Forward: every declared class appears on its own row.
    for (const [id, , declared] of ROWS) {
      assert.equal(byId.get(id), declared, `#${id} Type column`);
    }

    // Negative control: a class no schema declares must degrade to the token it
    // arrived as or to 'Unknown' — never to an invented class name.
    assert.equal(
      IfcTypeEnumFromString(UNKNOWN_CLASS.raw),
      IfcTypeEnum.Unknown,
      'the negative control must genuinely be outside IfcTypeEnum',
    );
    const unknown = byId.get(UNKNOWN_CLASS.id);
    assert.ok(
      unknown === 'Unknown' || unknown === UNKNOWN_CLASS.raw,
      `an undeclared class must degrade, got ${unknown}`,
    );

    // Reverse: nothing else leaked in. The whole multiset, not a count —
    // this defect swaps classes without changing any count.
    assert.deepEqual(
      [...byId.entries()].sort((a, b) => a[0] - b[0]),
      [...ROWS.map(([id, , declared]) => [id, declared] as [number, string]), [UNKNOWN_CLASS.id, unknown!]],
    );
  });

  it('grouping is unaffected: getTypeName still answers the coalesced family name', () => {
    const s = store();
    // The ~90 grouping call sites read this, and filter-evaluate.ts matches it
    // for equality, so it must not shift.
    assert.equal(s.entities.getTypeName(3), 'IfcDoor');
    assert.equal(s.entities.getTypeName(9), 'IfcSlab');
    assert.equal(s.entities.getTypeName(4), 'IfcWallStandardCase');
    assert.equal(s.entities.getTypeName(10), 'IfcSanitaryTerminal');
    assert.equal(s.entities.getTypeName(999_999), 'Unknown');
  });

  it('degrades to Unknown for an expressId the table does not hold', () => {
    const entities = store().entities as unknown as {
      getExactTypeName?(id: number): string;
      getTypeName(id: number): string;
    };
    assert.equal(entities.getExactTypeName?.(999_999) ?? 'Unknown', 'Unknown');
    assert.equal(entities.getTypeName(999_999), 'Unknown');
  });
});
