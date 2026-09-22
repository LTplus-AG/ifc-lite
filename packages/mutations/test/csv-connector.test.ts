/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { CsvConnector, MutablePropertyView, MutationGuardError, type DataMapping } from '../src/index.js';

/**
 * Builds a minimal EntityTable-shaped mock, matching the fixture style used
 * in mutations.test.ts's BulkQueryEngine test.
 */
function makeEntities(rows: Array<{ expressId: number; globalId: string; name: string }>) {
  const strings: string[] = [];
  const intern = (s: string) => {
    strings.push(s);
    return strings.length - 1;
  };

  const entities = {
    count: rows.length,
    expressId: new Int32Array(rows.map((r) => r.expressId)),
    typeEnum: new Uint32Array(rows.map(() => 10)),
    globalId: new Int32Array(rows.map((r) => intern(r.globalId))),
    name: new Int32Array(rows.map((r) => intern(r.name))),
  } as any;

  return { entities, strings: { get: (idx: number) => strings[idx] } };
}

function makeConnector(rows: Array<{ expressId: number; globalId: string; name: string }>) {
  const { entities, strings } = makeEntities(rows);
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor(() => []);
  const connector = new CsvConnector(entities, view, strings);
  return { connector, view };
}

/**
 * Same fixture shape as {@link makeEntities}, plus an optional `getTag` —
 * the entity-table read path the `tag` match strategy (#5167) uses.
 */
function makeConnectorWithTags(
  rows: Array<{ expressId: number; globalId: string; name: string; tag?: string }>
) {
  const { entities, strings } = makeEntities(rows);
  const tagByExpressId = new Map(rows.map((r) => [r.expressId, r.tag ?? '']));
  entities.getTag = (expressId: number) => tagByExpressId.get(expressId) ?? '';
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor(() => []);
  const connector = new CsvConnector(entities, view, strings);
  return { connector, view };
}

/**
 * Fixture for the `property` match strategy (#5167): each entity's property
 * sets come from `MutablePropertyView`'s on-demand extractor, matching how
 * the connector actually reads them in production (`getForEntity`, with
 * pending mutations applied).
 */
function makeConnectorWithProperties(
  entityIds: number[],
  psetsByEntity: Record<
    number,
    Array<{ name: string; properties: Array<{ name: string; type: PropertyValueType; value: unknown }> }>
  >
) {
  const rows = entityIds.map((id) => ({ expressId: id, globalId: `guid-${id}`, name: `Entity ${id}` }));
  const { entities, strings } = makeEntities(rows);
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor((entityId) =>
    (psetsByEntity[entityId] ?? []).map((pset) => ({
      name: pset.name,
      properties: pset.properties.map((p) => ({ name: p.name, type: p.type, value: p.value })),
    }))
  );
  const connector = new CsvConnector(entities, view, strings);
  return { connector, view };
}

describe('CsvConnector.parse (parseCsvLine)', () => {
  it('splits quoted values that contain the delimiter and unescapes doubled quotes', () => {
    const { connector } = makeConnector([]);

    const content = 'GlobalId,Name,Note\nG1,"Wall, North","She said ""hi"""';
    const rows = connector.parse(content);

    expect(rows).toEqual([
      { GlobalId: 'G1', Name: 'Wall, North', Note: 'She said "hi"' },
    ]);
  });

  it('does not split on a delimiter that appears inside quotes across multiple columns', () => {
    const { connector } = makeConnector([]);

    const content = 'A,B\n"1,2","3,4"';
    const rows = connector.parse(content);

    expect(rows).toEqual([{ A: '1,2', B: '3,4' }]);
  });
});

describe('CsvConnector.match (matchRow)', () => {
  it('matches by GlobalId with full confidence', () => {
    const { connector } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
      { expressId: 2, globalId: 'guid-b', name: 'Wall B' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ GlobalId: 'guid-b' }], mapping);

    expect(result.matchedEntityIds).toEqual([2]);
    expect(result.confidence).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('matches by ExpressId, parsing the numeric column', () => {
    const { connector } = makeConnector([
      { expressId: 42, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'expressId', column: 'Id' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Id: '42' }], mapping);

    expect(result.matchedEntityIds).toEqual([42]);
    expect(result.confidence).toBe(1);
  });

  it('matches by Name case-insensitively', () => {
    const { connector } = makeConnector([
      { expressId: 5, globalId: 'guid-a', name: 'Wall Alpha' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'name', column: 'Name' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Name: 'wall alpha' }], mapping);

    expect(result.matchedEntityIds).toEqual([5]);
    expect(result.confidence).toBe(1);
  });

  it('flags multiple matches with confidence 0.5 and a warning (data-loss risk: ambiguous target)', () => {
    // Two entities sharing the same Name means a name-based bulk edit would
    // silently fan out to both instead of the intended one.
    const { connector } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall Alpha' },
      { expressId: 2, globalId: 'guid-b', name: 'Wall Alpha' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'name', column: 'Name' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Name: 'Wall Alpha' }], mapping);

    expect(result.matchedEntityIds).toEqual([1, 2]);
    expect(result.confidence).toBe(0.5);
    expect(result.warnings).toEqual([
      'Multiple entities (2) matched for value "Wall Alpha"',
    ]);
  });

  it('warns and reports zero confidence for an empty match value', () => {
    const { connector } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall Alpha' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ GlobalId: '' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.warnings).toEqual(['Empty match value in column "GlobalId"']);
  });

  it('warns once (not per row) when the match column is missing from the CSV header entirely', () => {
    const { connector } = makeConnector([{ expressId: 1, globalId: 'guid-a', name: 'Wall A' }]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [],
    };

    // Every row is missing the "GlobalId" key entirely -- a different CSV
    // shape from "the column exists but this cell is blank".
    const rows = [{ OtherColumn: 'x' }, { OtherColumn: 'y' }, { OtherColumn: 'z' }];
    const results = connector.match(rows, mapping);

    const allWarnings = results.flatMap((r) => r.warnings ?? []);
    expect(allWarnings).toEqual(['Match column "GlobalId" not found in CSV header']);
    expect(results.every((r) => r.matchedEntityIds.length === 0)).toBe(true);
  });
});

/**
 * #5167 task 3.1: the `tag` strategy matches on the IFC `Tag` attribute (the
 * usual join key from a fabrication/scheduling spreadsheet).
 */
describe('CsvConnector.match: tag strategy (#5167)', () => {
  it('matches by the Tag attribute', () => {
    const { connector } = makeConnectorWithTags([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A', tag: 'P1-001' },
      { expressId: 2, globalId: 'guid-b', name: 'Wall B', tag: 'P1-002' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'tag', column: 'Mark' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Mark: 'P1-002' }], mapping);

    expect(result.matchedEntityIds).toEqual([2]);
    expect(result.confidence).toBe(1);
  });

  it('a pending Tag attribute overlay edit wins over the base value', () => {
    const { connector, view } = makeConnectorWithTags([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A', tag: 'BASE-TAG' },
    ]);
    view.setAttribute(1, 'Tag', 'OVERLAY-TAG');

    const mapping: DataMapping = {
      matchStrategy: { type: 'tag', column: 'Mark' },
      propertyMappings: [],
    };

    // The overlay edit, not the base EntityTable.getTag() value, is what a
    // CSV import matched right after an in-session Tag edit must honour.
    const [result] = connector.match([{ Mark: 'OVERLAY-TAG' }], mapping);
    expect(result.matchedEntityIds).toEqual([1]);

    const [staleResult] = connector.match([{ Mark: 'BASE-TAG' }], mapping);
    expect(staleResult.matchedEntityIds).toEqual([]);
  });
});

/**
 * #5167 task 3.1: the `property` strategy matches on the value of an
 * existing `psetName.propName`, reading through `MutablePropertyView`'s
 * overlay (`getForEntity`) rather than a raw property table.
 */
describe('CsvConnector.match: property strategy (#5167)', () => {
  it('matches through the SECOND same-named property set (type + occurrence), not just the first', () => {
    // Two entities each carry a TYPE-level and an OCCURRENCE-level
    // "Pset_Common", same name, different Mark values -- the shape
    // scripts/check-pset-name-find*.mjs exists to catch a two-step `.find`
    // getting wrong. 'OCC-2' only lives on entity 2's SECOND same-named
    // pset; a `psets.find(s => s.name === X)?.properties.find(...)` would
    // only ever see the FIRST 'Pset_Common' (Mark=TYPE-A) and report this
    // row unmatched.
    const { connector } = makeConnectorWithProperties([1, 2], {
      1: [
        { name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'TYPE-A' }] },
        { name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'OCC-1' }] },
      ],
      2: [
        { name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'TYPE-A' }] },
        { name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'OCC-2' }] },
      ],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Mark: 'OCC-2' }], mapping);

    expect(result.matchedEntityIds).toEqual([2]);
    expect(result.confidence).toBe(1);
  });

  it('does not report a single entity as ambiguous when its two same-named sets hold the SAME value', () => {
    // Review finding on #5230: scanning every same-named pset is required for
    // correctness, but an entity whose TYPE and OCCURRENCE sets both carry
    // `Mark: "A"` was indexed twice under that key. The single real match then
    // came back as `[1, 1]` with an ambiguity warning and confidence 0.5.
    const { connector } = makeConnectorWithProperties([1], {
      1: [
        { name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'A' }] },
        { name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'A' }] },
      ],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Mark: 'A' }], mapping);

    expect(result.matchedEntityIds).toEqual([1]);
    expect(result.confidence).toBe(1);
    expect((result.warnings ?? []).filter((w) => /Multiple entities/.test(w))).toEqual([]);
  });

  it('flags ambiguity when the value matches more than one entity', () => {
    const { connector } = makeConnectorWithProperties([1, 2], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'TYPE-A' }] }],
      2: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'TYPE-A' }] }],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Mark: 'TYPE-A' }], mapping);

    expect(result.matchedEntityIds).toEqual([1, 2]);
    expect(result.confidence).toBe(0.5);
    expect(result.warnings).toEqual(['Multiple entities (2) matched for value "TYPE-A"']);
  });

  it('warns and reports zero confidence for an empty match value', () => {
    const { connector } = makeConnectorWithProperties([1], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'A' }] }],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Mark: '' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.warnings).toEqual(['Empty match value in column "Mark"']);
  });

  it('compares a Real property type-aware, not by raw string identity ("60.0" vs stored 60)', () => {
    const { connector } = makeConnectorWithProperties([1], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'Area', type: PropertyValueType.Real, value: 60 }] }],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Area', column: 'Area' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Area: '60.0' }], mapping);

    expect(result.matchedEntityIds).toEqual([1]);
  });

  it('skips (does not fabricate a match for) a malformed Real cell, same PARSE_INVALID contract as generateMutations', () => {
    const { connector } = makeConnectorWithProperties([1], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'Area', type: PropertyValueType.Real, value: 60 }] }],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Area', column: 'Area' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Area: 'N/A' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('Area') && w.includes('N/A'))).toBe(true);
  });

  it('builds the index ONCE per match() call, not once per row (proves indexing, not a per-row scan)', () => {
    const { connector, view } = makeConnectorWithProperties([1, 2, 3], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'A' }] }],
      2: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'B' }] }],
      3: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'C' }] }],
    });
    const getForEntitySpy = vi.spyOn(view, 'getForEntity');

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    // 3 entities, 5 rows. A per-row linear scan would read every entity's
    // properties once per row (15 calls, O(rows × entities)); the indexed
    // strategy reads each entity exactly once regardless of row count.
    const rows = [{ Mark: 'A' }, { Mark: 'B' }, { Mark: 'C' }, { Mark: 'A' }, { Mark: 'B' }];
    const results = connector.match(rows, mapping);

    expect(getForEntitySpy).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.matchedEntityIds)).toEqual([[1], [2], [3], [1], [2]]);
  });
});

describe('CsvConnector.generateMutations', () => {
  it('applies a transform when provided instead of the default parseValue path', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'Rating',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'FireRating',
          valueType: PropertyValueType.Real,
          // Transform overrides the default numeric parseValue coercion.
          transform: (value) => `custom:${value}`,
        },
      ],
    };

    const rows = connector.parse('GlobalId,Rating\nguid-a,60');
    const matches = connector.match(rows, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toHaveLength(1);
    expect(mutations[0].newValue).toBe('custom:60');
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBe('custom:60');
  });

  it('falls back to parseValue for numeric columns without a transform', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'Transmittance',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'ThermalTransmittance',
          valueType: PropertyValueType.Real,
        },
      ],
    };

    const rows = connector.parse('GlobalId,Transmittance\nguid-a,0.35');
    const matches = connector.match(rows, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations[0].newValue).toBe(0.35);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'ThermalTransmittance')).toBe(0.35);
  });

  it('skips a mapping when the source cell is empty or missing (no phantom mutation)', () => {
    const { connector } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'FireRating',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'FireRating',
          valueType: PropertyValueType.String,
        },
      ],
    };

    const rows = connector.parse('GlobalId,FireRating\nguid-a,');
    const matches = connector.match(rows, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toEqual([]);
  });
});

/**
 * A malformed numeric cell ("N/A", blank after trim, or any non-numeric
 * text) fell through `parseFloat(value) || 0` / `parseInt(value, 10) || 0`.
 * `NaN || 0` is `0`, so a dirty CSV column silently wrote a real `0`
 * mutation — indistinguishable from a legitimately-imported zero — instead
 * of being skipped and reported, which is exactly what the sibling
 * ExpressId matcher above already does with an `isNaN` guard (see 'matches
 * by ExpressId, parsing the numeric column').
 */
describe('CsvConnector.generateMutations: malformed numeric cells', () => {
  it('does not write 0 for a non-numeric Real cell; skips the mutation instead', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'Transmittance',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'ThermalTransmittance',
          valueType: PropertyValueType.Real,
        },
      ],
    };

    const rows = connector.parse('GlobalId,Transmittance\nguid-a,N/A');
    const matches = connector.match(rows, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toEqual([]);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'ThermalTransmittance')).toBeNull();
  });

  it('does not write 0 for a non-numeric Integer cell; skips the mutation instead', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'FloorCount',
          targetPset: 'Pset_BuildingCommon',
          targetProperty: 'NumberOfStoreys',
          valueType: PropertyValueType.Integer,
        },
      ],
    };

    const rows = connector.parse('GlobalId,FloorCount\nguid-a,TBD');
    const matches = connector.match(rows, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toEqual([]);
    expect(view.getPropertyValue(1, 'Pset_BuildingCommon', 'NumberOfStoreys')).toBeNull();
  });

  it('still writes a genuine 0 for Real and Integer cells', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'Transmittance',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'ThermalTransmittance',
          valueType: PropertyValueType.Real,
        },
        {
          sourceColumn: 'FloorCount',
          targetPset: 'Pset_BuildingCommon',
          targetProperty: 'NumberOfStoreys',
          valueType: PropertyValueType.Integer,
        },
      ],
    };

    const rows = connector.parse('GlobalId,Transmittance,FloorCount\nguid-a,0,0');
    const matches = connector.match(rows, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toHaveLength(2);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'ThermalTransmittance')).toBe(0);
    expect(view.getPropertyValue(1, 'Pset_BuildingCommon', 'NumberOfStoreys')).toBe(0);
  });

  it('reports a warning through import() stats instead of failing silently', () => {
    const { connector } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'Transmittance',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'ThermalTransmittance',
          valueType: PropertyValueType.Real,
        },
      ],
    };

    const stats = connector['import']('GlobalId,Transmittance\nguid-a,N/A', mapping);

    expect(stats.mutationsCreated).toBe(0);
    expect(stats.warnings.some((w) => w.includes('Transmittance'))).toBe(true);
  });
});

/**
 * The List branch used to pick its encoding by catching a `JSON.parse` throw,
 * so a malformed JSON list took the semicolon path and `[1,2` was written as
 * the one-element array `['[1,2']`: a fabricated value indistinguishable from
 * an imported one, the same class of silent damage PARSE_INVALID was added to
 * stop on numeric cells. The encoding is chosen on shape now, so the broken
 * cell is skipped and reported while the semicolon form still imports.
 */
describe('CsvConnector.generateMutations: malformed List cells', () => {
  const mapping: DataMapping = {
    matchStrategy: { type: 'globalId', column: 'GlobalId' },
    propertyMappings: [
      {
        sourceColumn: 'Tags',
        targetPset: 'Pset_WallCommon',
        targetProperty: 'Tags',
        valueType: PropertyValueType.List,
      },
    ],
  };

  it('does not write the raw cell as a one-element array; skips and warns instead', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const stats = connector['import']('GlobalId,Tags\nguid-a,"[1,2"', mapping);

    expect(stats.mutationsCreated).toBe(0);
    expect(stats.warnings.some((w) => w.includes('Tags'))).toBe(true);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'Tags')).toBeNull();
  });

  it('still imports the semicolon encoding of a list', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);

    const stats = connector['import']('GlobalId,Tags\nguid-a,a;b', mapping);

    expect(stats.mutationsCreated).toBe(1);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'Tags')).toEqual(['a', 'b']);
  });
});

/**
 * github.com/LTplus-AG/ifc-lite/issues/2765: replacing the Boolean/Logical
 * parse branch with `return false` left 172 tests green. Every truthy spelling
 * a checkbox column can carry silently became false, and the only production
 * caller is an untested UI component, so a CSV import of a checkbox column had
 * no assertion anywhere. The accepted spellings ARE the contract here: a
 * `Yes`/`1` column is what a spreadsheet exports, not an exotic input.
 */
describe('CsvConnector.generateMutations: boolean columns', () => {
  /** Import one cell into a Boolean/Logical property and read the value back. */
  function importCell(raw: string, valueType: PropertyValueType): unknown {
    const { connector } = makeConnector([{ expressId: 1, globalId: 'guid-a', name: 'Wall A' }]);
    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'LoadBearing',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'LoadBearing',
          valueType,
        },
      ],
    };
    const rows = connector.parse(`GlobalId,LoadBearing\nguid-a,${raw}`);
    const matches = connector.match(rows, mapping);
    return connector.generateMutations(matches, mapping)[0]?.newValue;
  }

  for (const raw of ['true', 'TRUE', 'True', 'yes', 'YES', '1']) {
    it(`reads ${raw} as true`, () => {
      expect(importCell(raw, PropertyValueType.Boolean)).toBe(true);
    });
  }

  for (const raw of ['false', 'FALSE', 'no', '0', 'maybe']) {
    it(`reads ${raw} as false`, () => {
      expect(importCell(raw, PropertyValueType.Boolean)).toBe(false);
    });
  }

  it('parses a Logical column through the same branch as a Boolean one', () => {
    // Logical shares the Boolean case by fallthrough, so it has to be asserted
    // separately: a change that splits them would leave Logical unpinned.
    expect(importCell('yes', PropertyValueType.Logical)).toBe(true);
    expect(importCell('no', PropertyValueType.Logical)).toBe(false);
  });
});

describe('CsvConnector.import', () => {
  it('imports a batch by GlobalId, reporting matched/unmatched stats and applying mutations', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
      { expressId: 2, globalId: 'guid-b', name: 'Wall B' },
    ]);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'FireRating',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'FireRating',
          valueType: PropertyValueType.String,
        },
      ],
    };

    const content = 'GlobalId,FireRating\nguid-a,REI 60\nguid-missing,REI 90';
    const stats = connector['import'](content, mapping);

    expect(stats.totalRows).toBe(2);
    expect(stats.matchedRows).toBe(1);
    expect(stats.unmatchedRows).toBe(1);
    expect(stats.mutationsCreated).toBe(1);
    expect(stats.errors).toEqual([]);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBe('REI 60');
    expect(view.getPropertyValue(2, 'Pset_WallCommon', 'FireRating')).toBeNull();
  });
});

describe('CsvConnector.importAsync', () => {
  it('batches rows and reports progress through parsing/matching/applying, ending at 100%', async () => {
    const rowCount = 5;
    const entityRows = Array.from({ length: rowCount }, (_, i) => ({
      expressId: i + 1,
      globalId: `guid-${i}`,
      name: `Wall ${i}`,
    }));
    const { connector, view } = makeConnector(entityRows);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'FireRating',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'FireRating',
          valueType: PropertyValueType.String,
        },
      ],
    };

    const lines = ['GlobalId,FireRating'];
    for (const row of entityRows) {
      lines.push(`${row.globalId},REI ${row.expressId}0`);
    }
    const content = lines.join('\n');

    const progressUpdates: number[] = [];
    const phases: string[] = [];
    const stats = await connector.importAsync(
      content,
      mapping,
      (progress) => {
        progressUpdates.push(progress.percent);
        phases.push(progress.phase);
      },
      { batchSize: 2 }
    );

    expect(stats.totalRows).toBe(rowCount);
    expect(stats.matchedRows).toBe(rowCount);
    expect(stats.mutationsCreated).toBe(rowCount);
    // Small batch size (2) over 5 rows forces multiple matching/applying batches.
    expect(phases).toContain('matching');
    expect(phases).toContain('applying');
    expect(progressUpdates[progressUpdates.length - 1]).toBeCloseTo(1, 5);
    // Progress must be monotonically non-decreasing across the whole run.
    for (let i = 1; i < progressUpdates.length; i++) {
      expect(progressUpdates[i]).toBeGreaterThanOrEqual(progressUpdates[i - 1]);
    }
    expect(view.getPropertyValue(3, 'Pset_WallCommon', 'FireRating')).toBe('REI 30');
  });
});

/**
 * `CsvConnector` writes straight to `MutablePropertyView.setProperty`,
 * bypassing the viewer store's own `setProperty` action and its
 * `canCollabEdit()` check entirely (DataConnector.tsx constructs and drives
 * this class directly — see mutation-guard.ts). These tests prove the
 * engine refuses a write on its own when constructed with a `canEdit`
 * predicate that returns false — without any caller having to remember to
 * check the role first.
 */
describe('CsvConnector: local-edit guard (mutation-guard.ts)', () => {
  const rows = [{ expressId: 1, globalId: 'guid-a', name: 'Wall A' }];
  const mapping: DataMapping = {
    matchStrategy: { type: 'globalId', column: 'GlobalId' },
    propertyMappings: [
      {
        sourceColumn: 'Rating',
        targetPset: 'Pset_WallCommon',
        targetProperty: 'FireRating',
        valueType: PropertyValueType.Real,
      },
    ],
  };
  const content = 'GlobalId,Rating\nguid-a,60';

  it('generateMutations throws MutationGuardError and applies nothing when canEdit() is false', () => {
    const { entities, strings } = makeEntities(rows);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const connector = new CsvConnector(entities, view, strings, () => false);

    const parsed = connector.parse(content);
    const matches = connector.match(parsed, mapping);

    expect(() => connector.generateMutations(matches, mapping)).toThrow(MutationGuardError);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBeNull();
    expect(view.hasChanges()).toBe(false);
  });

  it('generateMutations still applies when canEdit() is true (guard is opt-in, not a new default)', () => {
    const { entities, strings } = makeEntities(rows);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const connector = new CsvConnector(entities, view, strings, () => true);

    const parsed = connector.parse(content);
    const matches = connector.match(parsed, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toHaveLength(1);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBe(60);
  });

  it("['import'] (sync) surfaces the refusal as a stats error, not a silent no-op", () => {
    const { entities, strings } = makeEntities(rows);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const connector = new CsvConnector(entities, view, strings, () => false);

    const stats = connector['import'](content, mapping);

    expect(stats.mutationsCreated).toBe(0);
    expect(stats.errors.length).toBeGreaterThan(0);
    expect(view.hasChanges()).toBe(false);
  });

  it('importAsync surfaces the refusal as a stats error, not a silent no-op', async () => {
    const { entities, strings } = makeEntities(rows);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const connector = new CsvConnector(entities, view, strings, () => false);

    const stats = await connector.importAsync(content, mapping, () => {});

    expect(stats.mutationsCreated).toBe(0);
    expect(stats.errors.length).toBeGreaterThan(0);
    expect(view.hasChanges()).toBe(false);
  });

  it('a connector with no canEdit predicate behaves exactly as before (backward compatible)', () => {
    const { connector, view } = makeConnector(rows);

    const parsed = connector.parse(content);
    const matches = connector.match(parsed, mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toHaveLength(1);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBe(60);
  });
});
