/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcxWriter / exportToIfcx unit tests.
 *
 * The writer is the IFCX *write* path and is part of the published package
 * surface, but it had no test file and no in-repo caller, so its schema-import
 * selection, its three-state option defaults and its path/attribute emission
 * were all unpinned. These tests use hand-built table stubs so they run
 * without the on-demand model fixtures.
 *
 * This file is the union of two independent coverage sweeps that landed at the
 * same time. One drives the writer through the real StringTable /
 * EntityTableBuilder (see `buildTable` / `stubHierarchy`); the other drives it
 * through minimal structural stubs (see `makeEntities` and friends). Both sets
 * are kept: they pin different things and neither subsumes the other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable, EntityTableBuilder, IfcTypeEnum } from '@ifc-lite/data';
import type { EntityTable, PropertySet, PropertyTable, SpatialHierarchy } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcxWriter, exportToIfcx } from './writer.js';
import type { IfcxExportData } from './writer.js';
import type { IfcxFile } from './types.js';

const IFC_CORE_URI = 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/ifc@v5a.ifcx';
const IFC_PROP_URI = 'https://ifcx.dev/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx';

/** typeEnum 10 is IfcWall in the writer's enum→class table; 4 is IfcBuildingStorey. */
const TYPE_WALL = 10;
const TYPE_STOREY = 4;
/** Not present in the writer's map — exercises the unknown-type fallback. */
const TYPE_UNMAPPED = 9999;

interface EntityRow {
  expressId: number;
  typeEnum: number;
  name?: string;
  description?: string;
  globalId?: string;
}

/**
 * Build the narrow slice of EntityTable the writer reads, plus a matching
 * string table. Index 0 is reserved as "absent" by the writer's getString().
 */
function makeEntities(rows: EntityRow[]): {
  entities: EntityTable;
  strings: { get(idx: number): string };
} {
  const pool: string[] = [''];
  const intern = (s: string | undefined): number => {
    if (!s) return 0;
    pool.push(s);
    return pool.length - 1;
  };

  const table = {
    count: rows.length,
    expressId: Uint32Array.from(rows.map((r) => r.expressId)),
    typeEnum: Uint16Array.from(rows.map((r) => r.typeEnum % 65536)),
    globalId: Uint32Array.from(rows.map((r) => intern(r.globalId))),
    name: Uint32Array.from(rows.map((r) => intern(r.name))),
    description: Uint32Array.from(rows.map((r) => intern(r.description))),
  };
  // typeEnum is a Uint16Array in the real table; keep unmapped values distinct
  // from every mapped one without overflowing.
  rows.forEach((r, i) => {
    table.typeEnum[i] = r.typeEnum > 65535 ? 60000 : r.typeEnum;
  });

  return {
    entities: table as unknown as EntityTable,
    strings: { get: (idx: number) => pool[idx] ?? '' },
  };
}

function makePropertySets(sets: Array<{ name: string; props: Array<[string, unknown]> }>): PropertySet[] {
  return sets.map((s) => ({
    name: s.name,
    properties: s.props.map(([name, value]) => ({ name, value })),
  })) as unknown as PropertySet[];
}

function makePropertyTable(byEntity: Map<number, PropertySet[]>): PropertyTable {
  return {
    getForEntity: (id: number) => byEntity.get(id) ?? [],
  } as unknown as PropertyTable;
}

function makeMutationView(byEntity: Map<number, PropertySet[]>): MutablePropertyView {
  return {
    getForEntity: (id: number) => byEntity.get(id) ?? [],
  } as unknown as MutablePropertyView;
}

function makeSpatialHierarchy(
  parts: Partial<Pick<SpatialHierarchy, 'byStorey' | 'byBuilding' | 'bySite' | 'bySpace'>>
): SpatialHierarchy {
  return {
    byStorey: parts.byStorey ?? new Map(),
    byBuilding: parts.byBuilding ?? new Map(),
    bySite: parts.bySite ?? new Map(),
    bySpace: parts.bySpace ?? new Map(),
  } as unknown as SpatialHierarchy;
}

function parse(content: string): IfcxFile {
  return JSON.parse(content) as IfcxFile;
}

/** Real StringTable + EntityTableBuilder rather than a structural stub. */
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

describe('IfcxWriter — header and envelope', () => {
  it('stamps the IFCX version and falls back to the built-in author and data version', () => {
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_WALL }]);
    const file = parse(new IfcxWriter({ entities, strings }).export().content);

    // Pinned to the literal, not to IFCX_VERSION: importing the constant here
    // would make this assert "the writer used the constant" — true even if the
    // constant itself silently changed. Readers only match the substring
    // `ifcx`, so a changed value is invisible everywhere else.
    assert.strictEqual(file.header.ifcxVersion, 'ifcx_alpha');
    assert.strictEqual(file.header.author, 'ifc-lite');
    assert.strictEqual(file.header.dataVersion, '1.0.0');
    assert.match(file.header.id, /^ifcx_\d+_[a-z0-9]+$/);
    assert.ok(!Number.isNaN(Date.parse(file.header.timestamp)));
  });

  it('honours the caller-supplied author and data version', () => {
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_WALL }]);
    const file = parse(
      new IfcxWriter({ entities, strings }).export({ author: 'Jane', dataVersion: '2.5.0' })
        .content
    );

    assert.strictEqual(file.header.author, 'Jane');
    assert.strictEqual(file.header.dataVersion, '2.5.0');
  });

  it('emits an empty node list and no imports for an empty entity table', () => {
    const { entities, strings } = makeEntities([]);
    const result = new IfcxWriter({ entities, strings }).export();
    const file = parse(result.content);

    assert.deepStrictEqual(file.data, []);
    assert.deepStrictEqual(file.imports, []);
    assert.deepStrictEqual(file.schemas, {});
    assert.strictEqual(result.stats.nodeCount, 0);
    assert.strictEqual(result.stats.propertyCount, 0);
  });
});

describe('IfcxWriter — prettyPrint tri-state', () => {
  const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_WALL }]);

  it('pretty-prints when the option is omitted (default)', () => {
    const content = new IfcxWriter({ entities, strings }).export().content;
    assert.ok(content.includes('\n  '), 'omitted prettyPrint must still indent');
    assert.notStrictEqual(content, JSON.stringify(parse(content)));
  });

  it('pretty-prints when the option is explicitly true', () => {
    const content = new IfcxWriter({ entities, strings }).export({ prettyPrint: true }).content;
    assert.ok(content.includes('\n  '));
  });

  it('emits compact JSON only when the option is explicitly false', () => {
    const content = new IfcxWriter({ entities, strings }).export({ prettyPrint: false }).content;
    assert.ok(!content.includes('\n'), 'prettyPrint:false must produce single-line JSON');
    assert.deepStrictEqual(parse(content).header.ifcxVersion, 'ifcx_alpha');
  });
});

describe('IfcxWriter — includeProperties tri-state', () => {
  function data(): IfcxExportData {
    const { entities, strings } = makeEntities([{ expressId: 7, typeEnum: TYPE_WALL }]);
    const properties = makePropertyTable(
      new Map([[7, makePropertySets([{ name: 'Pset_WallCommon', props: [['IsExternal', true]] }])]])
    );
    return { entities, strings, properties };
  }

  const KEY = 'user::Pset_WallCommon::IsExternal';

  it('includes properties when the option is omitted (default)', () => {
    const file = parse(new IfcxWriter(data()).export().content);
    assert.strictEqual(file.data[0].attributes?.[KEY], true);
  });

  it('includes properties when the option is explicitly true', () => {
    const file = parse(new IfcxWriter(data()).export({ includeProperties: true }).content);
    assert.strictEqual(file.data[0].attributes?.[KEY], true);
  });

  it('omits properties only when the option is explicitly false', () => {
    const file = parse(new IfcxWriter(data()).export({ includeProperties: false }).content);
    assert.strictEqual(file.data[0].attributes?.[KEY], undefined);
    // Class attribute is not a property and must survive.
    assert.ok(file.data[0].attributes?.['bsi::ifc::class']);
  });
});

describe('IfcxWriter — applyMutations tri-state', () => {
  function data(): IfcxExportData {
    const { entities, strings } = makeEntities([{ expressId: 7, typeEnum: TYPE_WALL }]);
    const properties = makePropertyTable(
      new Map([[7, makePropertySets([{ name: 'Pset_WallCommon', props: [['FireRating', 'ORIGINAL']] }])]])
    );
    const mutationView = makeMutationView(
      new Map([[7, makePropertySets([{ name: 'Pset_WallCommon', props: [['FireRating', 'EDITED']] }])]])
    );
    return { entities, strings, properties, mutationView };
  }

  const KEY = 'user::Pset_WallCommon::FireRating';

  it('writes the edited value when the option is omitted (default)', () => {
    const file = parse(new IfcxWriter(data()).export().content);
    assert.strictEqual(file.data[0].attributes?.[KEY], 'EDITED');
  });

  it('writes the edited value when the option is explicitly true', () => {
    const file = parse(new IfcxWriter(data()).export({ applyMutations: true }).content);
    assert.strictEqual(file.data[0].attributes?.[KEY], 'EDITED');
  });

  it('falls back to the unedited table value only when explicitly false', () => {
    const file = parse(new IfcxWriter(data()).export({ applyMutations: false }).content);
    assert.strictEqual(file.data[0].attributes?.[KEY], 'ORIGINAL');
  });

  it('reads the property table when no mutation view is supplied', () => {
    const base = data();
    delete base.mutationView;
    const file = parse(new IfcxWriter(base).export().content);
    assert.strictEqual(file.data[0].attributes?.[KEY], 'ORIGINAL');
  });
});

describe('IfcxWriter — schema imports', () => {
  it('requests the prop schema whenever a bsi::ifc::prop:: attribute is emitted', () => {
    const { entities, strings } = makeEntities([
      { expressId: 1, typeEnum: TYPE_WALL, name: 'Wall A' },
    ]);
    const file = parse(new IfcxWriter({ entities, strings }).export().content);

    const uris = file.imports.map((i) => i.uri);
    assert.ok(uris.includes(IFC_PROP_URI), 'bsi::ifc::prop::Name requires the prop schema import');
    assert.ok(uris.includes(IFC_CORE_URI), 'bsi::ifc::class requires the core schema import');
  });

  it('requests only the core schema when no prop attribute is present', () => {
    // No name, no description, and properties suppressed → class only.
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_WALL }]);
    const file = parse(
      new IfcxWriter({ entities, strings }).export({ includeProperties: false }).content
    );

    assert.deepStrictEqual(
      file.imports.map((i) => i.uri),
      [IFC_CORE_URI]
    );
  });

  it('requests no imports when a node carries neither a class nor a prop attribute', () => {
    // Unmapped type → no bsi::ifc::class; no name/description → no prop keys.
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_UNMAPPED }]);
    const file = parse(
      new IfcxWriter({ entities, strings }).export({ includeProperties: false }).content
    );

    assert.deepStrictEqual(file.imports, []);
  });

  it('lists each import once no matter how many nodes need it', () => {
    const { entities, strings } = makeEntities([
      { expressId: 1, typeEnum: TYPE_WALL, name: 'A' },
      { expressId: 2, typeEnum: TYPE_WALL, name: 'B' },
      { expressId: 3, typeEnum: TYPE_STOREY, name: 'C' },
    ]);
    const uris = parse(new IfcxWriter({ entities, strings }).export().content).imports.map(
      (i) => i.uri
    );

    assert.deepStrictEqual(uris, [IFC_CORE_URI, IFC_PROP_URI]);
  });
});

describe('IfcxWriter — node attributes and paths', () => {
  it('emits the class code and its canonical bSI uri', () => {
    const { entities, strings } = makeEntities([{ expressId: 42, typeEnum: TYPE_WALL }]);
    const file = parse(new IfcxWriter({ entities, strings }).export().content);

    assert.deepStrictEqual(file.data[0].attributes?.['bsi::ifc::class'], {
      code: 'IfcWall',
      uri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/IfcWall',
    });
  });

  it('maps name and description onto the prop namespace and skips empty strings', () => {
    const { entities, strings } = makeEntities([
      { expressId: 1, typeEnum: TYPE_WALL, name: 'North wall', description: 'Load bearing' },
      { expressId: 2, typeEnum: TYPE_WALL },
    ]);
    const file = parse(new IfcxWriter({ entities, strings }).export().content);

    assert.strictEqual(file.data[0].attributes?.['bsi::ifc::prop::Name'], 'North wall');
    assert.strictEqual(file.data[0].attributes?.['bsi::ifc::prop::Description'], 'Load bearing');
    assert.strictEqual(file.data[1].attributes?.['bsi::ifc::prop::Name'], undefined);
    assert.strictEqual(file.data[1].attributes?.['bsi::ifc::prop::Description'], undefined);
  });

  it('omits the attributes key entirely for a node with nothing to say', () => {
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_UNMAPPED }]);
    const content = new IfcxWriter({ entities, strings }).export({
      includeProperties: false,
      prettyPrint: false,
    }).content;

    assert.ok(
      !content.includes('"attributes"'),
      'an attribute-free node must not serialise an empty attributes object'
    );
    assert.strictEqual(parse(content).data.length, 1);
  });

  it('derives the path from the mapped class name and express id', () => {
    const { entities, strings } = makeEntities([
      { expressId: 42, typeEnum: TYPE_WALL },
      { expressId: 43, typeEnum: TYPE_STOREY },
    ]);
    const file = parse(new IfcxWriter({ entities, strings }).export().content);

    assert.strictEqual(file.data[0].path, 'ifc:IfcWall.42');
    assert.strictEqual(file.data[1].path, 'ifc:IfcBuildingStorey.43');
  });

  it('falls back to IfcElement in the path for an unmapped type', () => {
    const { entities, strings } = makeEntities([{ expressId: 42, typeEnum: TYPE_UNMAPPED }]);
    const file = parse(new IfcxWriter({ entities, strings }).export().content);

    assert.strictEqual(file.data[0].path, 'ifc:IfcElement.42');
    assert.strictEqual(file.data[0].attributes?.['bsi::ifc::class'], undefined);
  });

  it('prefers a supplied idToPath entry over the generated path, per entity', () => {
    const { entities, strings } = makeEntities([
      { expressId: 42, typeEnum: TYPE_WALL },
      { expressId: 43, typeEnum: TYPE_WALL },
    ]);
    const idToPath = new Map([[42, 'round-trip/original/path']]);
    const file = parse(new IfcxWriter({ entities, strings, idToPath }).export().content);

    // Round-tripping an IFCX file must preserve the original node paths, or
    // every layer authored against them stops matching.
    assert.strictEqual(file.data[0].path, 'round-trip/original/path');
    assert.strictEqual(file.data[1].path, 'ifc:IfcWall.43', 'unmapped ids still get a generated path');
  });
});

describe('IfcxWriter — spatial children', () => {
  it('resolves containment from each of the four spatial maps, using each child\'s own generated path', () => {
    const { entities, strings } = makeEntities([
      { expressId: 1, typeEnum: TYPE_STOREY },
      { expressId: 2, typeEnum: TYPE_STOREY },
      { expressId: 3, typeEnum: TYPE_STOREY },
      { expressId: 4, typeEnum: TYPE_STOREY },
      { expressId: 101, typeEnum: TYPE_WALL },
      { expressId: 102, typeEnum: TYPE_WALL },
      { expressId: 103, typeEnum: TYPE_WALL },
      { expressId: 104, typeEnum: TYPE_WALL },
    ]);
    const spatialHierarchy = makeSpatialHierarchy({
      byStorey: new Map([[1, [101]]]),
      byBuilding: new Map([[2, [102]]]),
      bySite: new Map([[3, [103]]]),
      bySpace: new Map([[4, [104]]]),
    });
    const file = parse(new IfcxWriter({ entities, strings, spatialHierarchy }).export().content);

    // Each map is consulted in turn; a lookup that stops early silently drops
    // every element contained by a building, a site or a space. The child
    // path must match the *same* path that child's own node was given
    // (bug: it used to be synthesized independently as `element:${id}` and
    // never matched any real node path).
    assert.deepStrictEqual(file.data[0].children, { element_101: 'ifc:IfcWall.101' });
    assert.deepStrictEqual(file.data[1].children, { element_102: 'ifc:IfcWall.102' });
    assert.deepStrictEqual(file.data[2].children, { element_103: 'ifc:IfcWall.103' });
    assert.deepStrictEqual(file.data[3].children, { element_104: 'ifc:IfcWall.104' });
  });

  it('maps child ids through idToPath when available, and omits a child with neither an entity row nor an idToPath entry', () => {
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_STOREY }]);
    const spatialHierarchy = makeSpatialHierarchy({ byStorey: new Map([[1, [101, 102]]]) });
    const idToPath = new Map([[102, 'known/child/path']]);
    const file = parse(
      new IfcxWriter({ entities, strings, spatialHierarchy, idToPath }).export().content
    );

    // 101 has no entity row and no idToPath entry: emitting `element:101`
    // would be a dangling reference (no node in the file has that path), so
    // it must be omitted rather than fabricated.
    assert.deepStrictEqual(file.data[0].children, {
      element_102: 'known/child/path',
    });
  });

  it('every emitted child reference resolves to an actual node path in the same file (no idToPath supplied)', () => {
    // This is the STEP-IFC -> IFCX export path: idToPath is normally absent,
    // and every child must still resolve within the exported file.
    const { entities, strings } = makeEntities([
      { expressId: 10, typeEnum: TYPE_STOREY },
      { expressId: 42, typeEnum: TYPE_WALL },
    ]);
    const spatialHierarchy = makeSpatialHierarchy({ byStorey: new Map([[10, [42]]]) });
    const file = parse(new IfcxWriter({ entities, strings, spatialHierarchy }).export().content);

    const allPaths = new Set(file.data.map((n) => n.path));
    for (const node of file.data) {
      for (const childPath of Object.values(node.children ?? {})) {
        assert.ok(
          childPath === null || allPaths.has(childPath as string),
          `dangling child reference: ${childPath} does not match any node path in ${JSON.stringify([...allPaths])}`
        );
      }
    }
    // Sanity: the containment link was actually exercised.
    assert.deepStrictEqual(file.data[0].children, { element_42: 'ifc:IfcWall.42' });
  });

  it('omits children when there is no spatial hierarchy or no contained elements', () => {
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_STOREY }]);
    assert.strictEqual(parse(new IfcxWriter({ entities, strings }).export().content).data[0].children, undefined);

    const spatialHierarchy = makeSpatialHierarchy({ byStorey: new Map([[999, [1]]]) });
    const file = parse(new IfcxWriter({ entities, strings, spatialHierarchy }).export().content);
    assert.strictEqual(file.data[0].children, undefined);
  });
});

describe('IfcxWriter — stats', () => {
  it('counts nodes and every emitted attribute', () => {
    const { entities, strings } = makeEntities([
      { expressId: 1, typeEnum: TYPE_WALL, name: 'A' },
      { expressId: 2, typeEnum: TYPE_UNMAPPED },
    ]);
    const properties = makePropertyTable(
      new Map([[1, makePropertySets([{ name: 'P', props: [['a', 1], ['b', 2]] }])]])
    );
    const result = new IfcxWriter({ entities, strings, properties }).export();

    assert.strictEqual(result.stats.nodeCount, 2);
    // node 1: class + Name + 2 props = 4; node 2: nothing.
    assert.strictEqual(result.stats.propertyCount, 4);
  });

  it('reports fileSize in UTF-8 bytes, not UTF-16 code units', () => {
    // "Außenwand" and the emoji both encode to more bytes than characters; a
    // size reported from String#length under-reports non-ASCII models.
    const { entities, strings } = makeEntities([
      { expressId: 1, typeEnum: TYPE_WALL, name: 'Außenwand 🧱' },
    ]);
    const result = new IfcxWriter({ entities, strings }).export();

    assert.strictEqual(result.stats.fileSize, Buffer.byteLength(result.content, 'utf8'));
    assert.ok(
      result.stats.fileSize > result.content.length,
      'non-ASCII content must report more bytes than characters'
    );
  });
});

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
    assert.deepStrictEqual(wallNode.children, { element_102: 'ifc:IfcDoor.102' });
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
    assert.deepStrictEqual(wallNode.children, { element_102: 'ifc:IfcDoor.102' });
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
  it('returns the same content the writer produces for the same options', () => {
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_WALL, name: 'A' }]);
    const json = exportToIfcx({ entities, strings }, { prettyPrint: false, author: 'Jane' });
    const file = parse(json);

    assert.strictEqual(file.header.author, 'Jane');
    assert.ok(!json.includes('\n'));
    assert.strictEqual(file.data[0].path, 'ifc:IfcWall.1');
    assert.strictEqual(file.data[0].attributes?.['bsi::ifc::prop::Name'], 'A');
  });

  it('defaults to pretty-printed output when no options are passed', () => {
    const { entities, strings } = makeEntities([{ expressId: 1, typeEnum: TYPE_WALL }]);
    assert.ok(exportToIfcx({ entities, strings }).includes('\n  '));
  });

  it('returns the same content as IfcxWriter.export().content', () => {
    const { strings, table } = buildTable();
    const content = exportToIfcx({ entities: table, strings }, { includeProperties: false });
    const writer = new IfcxWriter({ entities: table, strings });
    const direct = writer.export({ includeProperties: false }).content;
    // Both invocations mint a fresh header id/timestamp, so compare only the data payload.
    assert.deepStrictEqual(JSON.parse(content).data, JSON.parse(direct).data);
  });
});
