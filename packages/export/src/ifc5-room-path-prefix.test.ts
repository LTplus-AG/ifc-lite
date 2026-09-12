/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Ifc5ExportOptions.stripPathPrefix` (#4444): a store reconstructed from a
 * shared room keys its entities by room path (`/<slotId>/<GlobalId>`), and an
 * export of it must carry the model's own `/<GlobalId>` paths — the same file
 * a single-model room (`/<GlobalId>` keys, no slot) exports — with every
 * `children` reference re-homed the same way.
 */

import { describe, it, expect } from 'vitest';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { stripNodePathPrefix } from './ifc5-export-helpers.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  RelationshipGraphBuilder,
  QuantityTableBuilder,
} from '@ifc-lite/data';

const GUIDS = { storey: '2O2Fr$t4X7Zf8NOew3FLKr', wall: '0BTBFw6f90Nfh9rP1dlXrb', slab: '1hOSvn6df7F8_7GcBWlSga' } as const;

interface IfcxNodeLike {
  path: string;
  children?: Record<string, string | null>;
  attributes?: Record<string, unknown>;
}

/** A storey with a wall and a slab, every GlobalId spelled by `keyed`. */
function storeKeyedBy(keyed: (guid: string) => string): IfcDataStore {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(3, strings);
  entities.add(10, 'IFCBUILDINGSTOREY', keyed(GUIDS.storey), 'Storey', '', '');
  entities.add(1, 'IFCWALL', keyed(GUIDS.wall), 'Wall', '', '');
  entities.add(2, 'IFCSLAB', keyed(GUIDS.slab), 'Slab', '', '');
  return {
    fileSize: 0, schemaVersion: 'IFC4', entityCount: 3, parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    strings,
    entities: entities.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
    spatialHierarchy: {
      project: { expressId: 10, name: 'Storey', children: [] },
      bySite: null,
      byBuilding: null,
      byStorey: new Map<number, number[]>([[10, [1, 2]]]),
      bySpace: null,
    },
  } as unknown as IfcDataStore;
}

function exportNodes(store: IfcDataStore, stripPathPrefix?: string): IfcxNodeLike[] {
  const file = JSON.parse(new Ifc5Exporter(store).export({ onlyTreeEntities: false, stripPathPrefix }).content) as {
    data: IfcxNodeLike[];
  };
  return file.data;
}

/** Nodes minus the document root, keyed by path, `children` values sorted for comparison. */
function entityNodes(nodes: IfcxNodeLike[]): Map<string, { children: string[]; name: unknown }> {
  const out = new Map<string, { children: string[]; name: unknown }>();
  for (const node of nodes) {
    if (!node.path.startsWith('/')) continue; // the synthetic document root (a generated UUID)
    out.set(node.path, {
      children: Object.values(node.children ?? {}).filter((c): c is string => typeof c === 'string').sort(),
      name: node.attributes?.['bsi::ifc::prop::Name'],
    });
  }
  return out;
}

describe('stripNodePathPrefix (#4444)', () => {
  it('removes the slot from a room path and leaves everything else alone', () => {
    expect(stripNodePathPrefix('/m1/0BTBFw6f90Nfh9rP1dlXrb', '/m1')).toBe('/0BTBFw6f90Nfh9rP1dlXrb');
    expect(stripNodePathPrefix('/m1/nested/ifcx/path', '/m1')).toBe('/nested/ifcx/path');
    // Another slot, a bare STEP GlobalId, a legacy room path, a prefix that is
    // only a spelling prefix (`/m1` vs `/m10`), and no prefix at all.
    expect(stripNodePathPrefix('/m0/0BTBFw6f90Nfh9rP1dlXrb', '/m1')).toBe('/m0/0BTBFw6f90Nfh9rP1dlXrb');
    expect(stripNodePathPrefix('0BTBFw6f90Nfh9rP1dlXrb', '/m1')).toBe('0BTBFw6f90Nfh9rP1dlXrb');
    expect(stripNodePathPrefix('/0BTBFw6f90Nfh9rP1dlXrb', '/m1')).toBe('/0BTBFw6f90Nfh9rP1dlXrb');
    expect(stripNodePathPrefix('/m10/x', '/m1')).toBe('/m10/x');
    expect(stripNodePathPrefix('/m1/x', undefined)).toBe('/m1/x');
    expect(stripNodePathPrefix('/m1/x', '')).toBe('/m1/x');
  });
});

describe('Ifc5Exporter stripPathPrefix (#4444)', () => {
  const singleModelRoom = storeKeyedBy((guid) => `/${guid}`);
  const slotM1 = storeKeyedBy((guid) => `/m1/${guid}`);

  it('exports a slot-keyed store with exactly the paths and children of a single-model room export', () => {
    const reference = entityNodes(exportNodes(singleModelRoom));
    const stripped = entityNodes(exportNodes(slotM1, '/m1'));
    expect([...stripped.keys()].sort()).toEqual([`/${GUIDS.storey}`, `/${GUIDS.wall}`, `/${GUIDS.slab}`].sort());
    expect(stripped).toEqual(reference);
    // Containment survives the re-homing: the storey lists both members by their stripped paths.
    expect(stripped.get(`/${GUIDS.storey}`)?.children).toEqual([`/${GUIDS.wall}`, `/${GUIDS.slab}`].sort());
  });

  it('without the option the slot leaks into every path (the pre-#4444 recipient export)', () => {
    const leaked = entityNodes(exportNodes(slotM1));
    expect([...leaked.keys()].every((p) => p.startsWith('/m1/'))).toBe(true);
    expect(leaked.get(`/m1/${GUIDS.storey}`)?.children).toEqual([`/m1/${GUIDS.wall}`, `/m1/${GUIDS.slab}`].sort());
  });

  it('is a no-op for a store outside the prefix (an owner exporting its own STEP model)', () => {
    const owner = storeKeyedBy((guid) => guid);
    const plain = JSON.stringify(exportNodes(owner).map((n) => [n.path, n.children ?? null]));
    const withOption = JSON.stringify(exportNodes(owner, '/m1').map((n) => [n.path, n.children ?? null]));
    expect(withOption).toBe(plain);
    expect(exportNodes(owner, '/m1').some((n) => n.path === GUIDS.wall)).toBe(true);
  });
});
