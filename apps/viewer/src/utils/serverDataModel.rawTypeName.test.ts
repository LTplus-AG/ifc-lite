/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The server-hydrated `EntityTable` must name a class that `IfcTypeEnum` does
 * not cover, exactly as the two other `EntityTable` implementations do
 * (`entityTableFromColumns` in packages/data, and the cache-restored table).
 *
 * `buildEntityTable` already receives the real class string from the server
 * (`cols.typeName[idx]`) and hands it to `CompactEntityIndexBuilder.add`, so
 * the correct name is in hand; answering `getTypeName` from the enum alone
 * discards it and reports `Unknown`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';
import type { CompactEntityIndex } from '@ifc-lite/parser';
import { convertServerDataModel, type ServerParseResult } from './serverDataModel';
import { buildTypeTree } from '../components/viewer/hierarchy/treeDataBuilder';

const parseResult: ServerParseResult = {
  cache_key: 'raw-type-name',
  metadata: { schema_version: 'IFC4' },
  stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
};

/** Classes the server can emit that `IfcTypeEnum` does not model. */
const OUTSIDE_ENUM = [
  { id: 100, raw: 'IFCPUMP', display: 'IfcPump' },
  { id: 101, raw: 'IFCCHILLER', display: 'IfcChiller' },
  { id: 102, raw: 'IFCBOREHOLE', display: 'IfcBorehole' },
];

/** A class the enum DOES cover — the negative control for the fallback. */
const INSIDE_ENUM = { id: 200, raw: 'IFCWALL', display: 'IfcWall' };

function dataModelFor(rows: { id: number; raw: string }[]): DataModel {
  return {
    entities: ServerEntityIndex.fromRows([
      { entity_id: 1, type_name: 'IFCPROJECT', global_id: 'Proj00000000000000001', name: 'P', has_geometry: false },
      ...rows.map((r, i) => ({
        entity_id: r.id,
        type_name: r.raw,
        global_id: `G${i}`.padEnd(22, 'x'),
        name: `E${r.id}`,
        has_geometry: true,
      })),
    ]),
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
          name: 'P',
          children_ids: [],
          element_ids: rows.map((r) => r.id),
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

describe('server-hydrated EntityTable.getTypeName', () => {
  it('anti-vacuity: the fixture classes really are outside IfcTypeEnum, and the control is inside', () => {
    assert.ok(OUTSIDE_ENUM.length >= 3, 'fixture must exercise more than one uncovered class');
    for (const { raw, display } of OUTSIDE_ENUM) {
      assert.equal(
        IfcTypeEnumFromString(raw),
        IfcTypeEnum.Unknown,
        `${raw} is in IfcTypeEnum — it no longer exercises the rawTypeName fallback`,
      );
      assert.equal(
        IfcTypeEnumFromString(display),
        IfcTypeEnum.Unknown,
        `${display} is in IfcTypeEnum — it no longer exercises the rawTypeName fallback`,
      );
    }
    assert.notEqual(
      IfcTypeEnumFromString(INSIDE_ENUM.raw),
      IfcTypeEnum.Unknown,
      'negative control must be a class the enum covers',
    );
  });

  it('names classes IfcTypeEnum does not cover instead of reporting Unknown', () => {
    const store = convertServerDataModel(
      dataModelFor([...OUTSIDE_ENUM, INSIDE_ENUM]),
      parseResult,
      { size: 1 },
      [],
    );

    for (const { id, raw, display } of OUTSIDE_ENUM) {
      // The correct name is demonstrably in hand: the same string the table
      // was built from is already retrievable from the compact index.
      assert.equal((store.entityIndex.byId as CompactEntityIndex).getType(id), raw, `compact index lost ${raw}`);
      assert.equal(
        store.entities.getTypeName(id),
        display,
        `getTypeName(${id}) must report ${display}, not the enum's Unknown`,
      );
    }

    // Negative control: an enum-covered class still answers from the enum.
    assert.equal(store.entities.getTypeName(INSIDE_ENUM.id), INSIDE_ENUM.display);

    // Negative control: an id that is not in the table still says Unknown.
    assert.equal(store.entities.getTypeName(999999), 'Unknown');
  });

  it('user-visible: the hierarchy By-Type tab groups each class separately, not into one Unknown bucket', () => {
    const store = convertServerDataModel(
      dataModelFor([...OUTSIDE_ENUM, INSIDE_ENUM]),
      parseResult,
      { size: 1 },
      [],
    );
    const geometricIds = new Set([...OUTSIDE_ENUM.map((e) => e.id), INSIDE_ENUM.id]);
    const nodes = buildTypeTree(new Map(), store, new Set(), false, geometricIds);

    const groupLabels = nodes.filter((n) => n.type === 'type-group').map((n) => n.name).sort();
    assert.deepEqual(
      groupLabels,
      [...OUTSIDE_ENUM.map((e) => e.display), INSIDE_ENUM.display].sort(),
      'each IFC class must get its own tab row',
    );
    assert.ok(
      !groupLabels.includes('Unknown'),
      'no class may collapse into the Unknown bucket',
    );
  });
});
