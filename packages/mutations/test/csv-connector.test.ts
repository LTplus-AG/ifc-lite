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
    // The effective-entity iterator reads a row's class through the table.
    getTypeName: () => 'IfcWall',
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

  it('keeps values of different declared types apart (Integer 1 vs String "01")', () => {
    // Review finding on #5230: the index captured the FIRST property type it
    // saw and canonicalized every later value with it, so an Integer `1` and a
    // String `"01"` collapsed to the same key and a CSV `"1"` matched both.
    const { connector } = makeConnectorWithProperties([1, 2], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.Integer, value: 1 }] }],
      2: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: '01' }] }],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    // The reported defect: "1" must not reach the String "01" entity.
    const [one] = connector.match([{ Mark: '1' }], mapping);
    expect(one.matchedEntityIds).toEqual([1]);
    expect(one.confidence).toBe(1);

    // "01" is genuinely ambiguous across these two types — it is the String
    // value verbatim AND a valid Integer 1 — so it matches both and must SAY
    // so rather than silently picking one. Asserted unconditionally: a guarded
    // assertion would pass vacuously if the Integer path were ever lost.
    const [zeroOne] = connector.match([{ Mark: '01' }], mapping);
    expect([...zeroOne.matchedEntityIds].sort()).toEqual([1, 2]);
    expect(zeroOne.confidence).toBe(0.5);
    expect((zeroOne.warnings ?? []).some((w) => /Multiple entities/.test(w))).toBe(true);
  });

  it('refuses an Express ID cell that is not wholly a positive integer', () => {
    // `parseInt` stops at the first non-digit, so these would have selected
    // entity 1 and written mutations onto the wrong entity.
    const { connector } = makeConnectorWithProperties([1, 2], {});
    const mapping: DataMapping = {
      matchStrategy: { type: 'expressId', column: 'Id' },
      propertyMappings: [],
    };

    for (const cell of ['1abc', '1.5', '1e2', '0', '-1', ' ']) {
      const [result] = connector.match([{ Id: cell }], mapping);
      expect(result.matchedEntityIds, `"${cell}" must not select an entity`).toEqual([]);
      expect(
        (result.warnings ?? []).some((w) => /Invalid Express ID|Empty match value/.test(w)),
        `"${cell}" must be reported`,
      ).toBe(true);
    }

    const [ok] = connector.match([{ Id: ' 1 ' }], mapping);
    expect(ok.matchedEntityIds, 'a surrounding-whitespace integer still matches').toEqual([1]);
  });

  it('warns per row when a present match column is blank, rather than failing silently', () => {
    // Review finding on #5230 claimed an all-blank present column yields zero
    // matches with no warning. It does warn: `parse` writes every header key,
    // so the column is correctly "present" and each blank cell is reported.
    const { connector } = makeConnectorWithProperties([1], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'A' }] }],
    });

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    const results = connector.match([{ Mark: '' }, { Mark: '   ' }], mapping);

    expect(results.map((r) => r.matchedEntityIds)).toEqual([[], []]);
    for (const result of results) {
      expect((result.warnings ?? []).some((w) => /Empty match value/.test(w))).toBe(true);
    }
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

  // #5427: every word parsed as `false`, so a Boolean property match on
  // `ja` selected every entity whose flag was false.
  it('does not match a word that is not a boolean against entities whose flag is false', () => {
    const { connector } = makeConnectorWithProperties([1], {
      1: [{ name: 'Pset_Common', properties: [{ name: 'IsExternal', type: PropertyValueType.Boolean, value: false }] }],
    });
    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'IsExternal', column: 'IsExternal' },
      propertyMappings: [],
    };

    const [ja, no] = connector.match([{ IsExternal: 'ja' }, { IsExternal: 'no' }], mapping);

    expect(ja.matchedEntityIds).toEqual([]);
    expect(ja.warnings?.some((w) => w.includes('"ja"'))).toBe(true);
    expect(no.matchedEntityIds).toEqual([1]);
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

  // #5427: `parseFloat` read the numeric PREFIX, so a European CSV's `12,5`
  // wrote 12 and reported nothing. Each such cell is now reported and skipped.
  it('reports and skips a Real or Integer cell that is only a numeric prefix', () => {
    const { connector, view } = makeConnector([{ expressId: 1, globalId: 'guid-a', name: 'Wall A' }]);
    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        { sourceColumn: 'Width', targetPset: 'Pset_WallCommon', targetProperty: 'Width', valueType: PropertyValueType.Real },
        { sourceColumn: 'Height', targetPset: 'Pset_WallCommon', targetProperty: 'Height', valueType: PropertyValueType.Real },
        { sourceColumn: 'Storeys', targetPset: 'Pset_BuildingCommon', targetProperty: 'NumberOfStoreys', valueType: PropertyValueType.Integer },
      ],
    };
    const rows = connector.parse('GlobalId;Width;Height;Storeys\nguid-a;12,5;60abc;2.7', { delimiter: ';' });
    const warnings: string[] = [];
    const mutations = connector.generateMutations(connector.match(rows, mapping), mapping, warnings);

    expect(mutations).toEqual([]);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'Width')).toBeNull();
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('could not parse "12,5" in column "Width" as Real');
    expect(warnings[1]).toContain('could not parse "60abc" in column "Height" as Real');
    expect(warnings[2]).toContain('could not parse "2.7" in column "Storeys" as Integer');
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

  for (const raw of ['false', 'FALSE', 'no', '0']) {
    it(`reads ${raw} as false`, () => {
      expect(importCell(raw, PropertyValueType.Boolean)).toBe(false);
    });
  }

  // #5427: any other word used to become `false`, so a German `ja` column
  // wrote the opposite of what it said. It is now left unwritten.
  for (const raw of ['maybe', 'ja', 'wahr', 'unknown']) {
    it(`writes nothing for ${raw}`, () => {
      expect(importCell(raw, PropertyValueType.Boolean)).toBeUndefined();
    });
  }

  it('parses a Logical column through the same branch as a Boolean one', () => {
    // Logical shares the Boolean case by fallthrough, so it has to be asserted
    // separately: a change that splits them would leave Logical unpinned.
    expect(importCell('yes', PropertyValueType.Logical)).toBe(true);
    expect(importCell('no', PropertyValueType.Logical)).toBe(false);
    // IFC LOGICAL's UNKNOWN has no boolean to land on; `false` would be a
    // fact the sheet did not state (#5427).
    expect(importCell('UNKNOWN', PropertyValueType.Logical)).toBeUndefined();
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

describe('CsvConnector.match: tombstoned entities are excluded (#5198)', () => {
  // Mirrors BulkQueryEngine's tombstone-enumeration fix (fix-5196-bulk-query-tombstone):
  // deletion is overlay-only, so csv-match.ts's index-building enumeration
  // must consult the mutation view's tombstones itself, for every strategy —
  // including `tag` and `property`, both added by #5230/#5167 after the
  // original (three-strategy) fix was written.

  it('globalId strategy excludes a tombstoned entity from the match', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);
    view.deleteEntity(1);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ GlobalId: 'guid-a' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
  });

  it('expressId strategy excludes a tombstoned entity from the match', () => {
    const { connector, view } = makeConnector([
      { expressId: 42, globalId: 'guid-a', name: 'Wall A' },
    ]);
    view.deleteEntity(42);

    const mapping: DataMapping = {
      matchStrategy: { type: 'expressId', column: 'Id' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Id: '42' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
  });

  it('name strategy excludes a tombstoned entity from the match', () => {
    const { connector, view } = makeConnector([
      { expressId: 5, globalId: 'guid-a', name: 'Wall Alpha' },
    ]);
    view.deleteEntity(5);

    const mapping: DataMapping = {
      matchStrategy: { type: 'name', column: 'Name' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Name: 'wall alpha' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
  });

  it('tag strategy excludes a tombstoned entity from the match', () => {
    const { connector, view } = makeConnectorWithTags([
      { expressId: 7, globalId: 'guid-a', name: 'Wall A', tag: 'P1-001' },
    ]);
    view.deleteEntity(7);

    const mapping: DataMapping = {
      matchStrategy: { type: 'tag', column: 'Mark' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Mark: 'P1-001' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
  });

  it('property strategy excludes a tombstoned entity from the match', () => {
    const { connector, view } = makeConnectorWithProperties([9], {
      9: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'A' }] }],
    });
    view.deleteEntity(9);

    const mapping: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    const [result] = connector.match([{ Mark: 'A' }], mapping);

    expect(result.matchedEntityIds).toEqual([]);
  });

  it('live entities of every strategy still match and still get mutations, unaffected by the filter (no-regression)', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall Alpha' },
      { expressId: 2, globalId: 'guid-b', name: 'Wall Beta' },
      { expressId: 3, globalId: 'guid-c', name: 'Wall Gamma' },
    ]);
    const { connector: tagConnector, view: tagView } = makeConnectorWithTags([
      { expressId: 4, globalId: 'guid-d', name: 'Wall Delta', tag: 'P1-004' },
    ]);
    const { connector: propConnector, view: propView } = makeConnectorWithProperties([5], {
      5: [{ name: 'Pset_Common', properties: [{ name: 'Mark', type: PropertyValueType.String, value: 'A' }] }],
    });

    const byGlobalId: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [],
    };
    const byExpressId: DataMapping = {
      matchStrategy: { type: 'expressId', column: 'Id' },
      propertyMappings: [],
    };
    const byName: DataMapping = {
      matchStrategy: { type: 'name', column: 'Name' },
      propertyMappings: [],
    };
    const byTag: DataMapping = {
      matchStrategy: { type: 'tag', column: 'Mark' },
      propertyMappings: [],
    };
    const byProperty: DataMapping = {
      matchStrategy: { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'Mark' },
      propertyMappings: [],
    };

    expect(connector.match([{ GlobalId: 'guid-a' }], byGlobalId)[0].matchedEntityIds).toEqual([1]);
    expect(connector.match([{ Id: '2' }], byExpressId)[0].matchedEntityIds).toEqual([2]);
    expect(connector.match([{ Name: 'wall gamma' }], byName)[0].matchedEntityIds).toEqual([3]);
    expect(tagConnector.match([{ Mark: 'P1-004' }], byTag)[0].matchedEntityIds).toEqual([4]);
    expect(propConnector.match([{ Mark: 'A' }], byProperty)[0].matchedEntityIds).toEqual([5]);

    expect(view.isDeleted(1)).toBe(false);
    expect(view.isDeleted(2)).toBe(false);
    expect(view.isDeleted(3)).toBe(false);
    expect(tagView.isDeleted(4)).toBe(false);
    expect(propView.isDeleted(5)).toBe(false);
  });

  it('full arc: match -> generateMutations -> value while deleted -> restoreFromTombstone -> the stale write is NOT there', () => {
    const { connector, view } = makeConnector([
      { expressId: 1, globalId: 'guid-a', name: 'Wall A' },
    ]);
    view.deleteEntity(1);
    expect(view.isDeleted(1)).toBe(true);

    const mapping: DataMapping = {
      matchStrategy: { type: 'globalId', column: 'GlobalId' },
      propertyMappings: [
        {
          sourceColumn: 'FireRating',
          targetPset: 'Pset_WallCommon',
          targetProperty: 'FireRating',
          valueType: PropertyValueType.Label,
        },
      ],
    };

    const matches = connector.match([{ GlobalId: 'guid-a', FireRating: 'STALE_VIA_CSV' }], mapping);
    const mutations = connector.generateMutations(matches, mapping);

    expect(mutations).toHaveLength(0);
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBeNull();

    const restored = view.restoreFromTombstone(1);
    expect(restored).toBe(true);
    expect(view.isDeleted(1)).toBe(false);

    // The critical assertion: undoing the delete must not resurrect a write
    // that happened while the entity was tombstoned.
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBeNull();
  });
});

describe('CsvConnector.match: overlay-created entities are candidates (#5198, #5249)', () => {
  // The other direction of the same enumeration defect: an entity created this
  // session has no base EntityTable row, so an importer that enumerates the
  // table can never match it, however the CSV names it.
  const WALL = (globalId: string, name: string, tag: string) =>
    [globalId, null, name, null, null, null, null, tag, null];

  const MAPPING: DataMapping = {
    matchStrategy: { type: 'globalId', column: 'GlobalId' },
    propertyMappings: [
      { sourceColumn: 'FireRating', targetPset: 'Pset_WallCommon', targetProperty: 'FireRating', valueType: PropertyValueType.String },
    ],
  };

  function withCreatedWall() {
    const { connector, view } = makeConnectorWithTags([
      { expressId: 1, globalId: 'guid-source', name: 'Source Wall', tag: 'S-1' },
    ]);
    // A live session seeds the allocator above the model's ids (StoreEditor).
    view.setExpressIdWatermark(100);
    const created = view.createEntity('IfcWall', WALL('guid-created', 'Created Wall', 'C-7')).expressId;
    return { connector, view, created };
  }

  const matchOne = (connector: CsvConnector, strategy: DataMapping['matchStrategy'], row: Record<string, string>) =>
    connector.match([row], { matchStrategy: strategy, propertyMappings: [] })[0].matchedEntityIds;

  it('globalId strategy matches a created entity by its authored GlobalId', () => {
    const { connector, created } = withCreatedWall();
    expect(matchOne(connector, { type: 'globalId', column: 'G' }, { G: 'guid-created' })).toEqual([created]);
    expect(matchOne(connector, { type: 'globalId', column: 'G' }, { G: 'guid-source' })).toEqual([1]);
  });

  it('expressId strategy matches a created entity by its allocated id', () => {
    const { connector, created } = withCreatedWall();
    expect(matchOne(connector, { type: 'expressId', column: 'Id' }, { Id: String(created) })).toEqual([created]);
  });

  it('name strategy matches a created entity by its authored Name, case-insensitively', () => {
    const { connector, created } = withCreatedWall();
    expect(matchOne(connector, { type: 'name', column: 'N' }, { N: 'created wall' })).toEqual([created]);
  });

  it('tag strategy matches a created entity by Tag, and a queued Tag edit wins over the authored one', () => {
    const { connector, view, created } = withCreatedWall();
    expect(matchOne(connector, { type: 'tag', column: 'T' }, { T: 'C-7' })).toEqual([created]);
    view.setAttribute(created, 'Tag', 'C-8');
    expect(matchOne(connector, { type: 'tag', column: 'T' }, { T: 'C-8' })).toEqual([created]);
    expect(matchOne(connector, { type: 'tag', column: 'T' }, { T: 'C-7' })).toEqual([]);
    // A second edit of the same attribute replaces the first: the overlay keys
    // attribute edits by (entity, attribute), so only the latest is current.
    view.setAttribute(created, 'Tag', 'C-9');
    expect(matchOne(connector, { type: 'tag', column: 'T' }, { T: 'C-9' })).toEqual([created]);
    expect(matchOne(connector, { type: 'tag', column: 'T' }, { T: 'C-8' })).toEqual([]);
  });

  it('property strategy matches a created entity through its overlay pset', () => {
    const { connector, view, created } = withCreatedWall();
    view.setProperty(created, 'Pset_Common', 'Mark', 'M-1', PropertyValueType.String);
    expect(
      matchOne(connector, { type: 'property', psetName: 'Pset_Common', propName: 'Mark', column: 'M' }, { M: 'M-1' }),
    ).toEqual([created]);
  });

  it('a created-then-deleted entity matches under no strategy', () => {
    const { connector, view, created } = withCreatedWall();
    view.deleteEntity(created);
    expect(matchOne(connector, { type: 'globalId', column: 'G' }, { G: 'guid-created' })).toEqual([]);
    expect(matchOne(connector, { type: 'expressId', column: 'Id' }, { Id: String(created) })).toEqual([]);
    expect(matchOne(connector, { type: 'tag', column: 'T' }, { T: 'C-7' })).toEqual([]);
  });

  it('full arc: importing a CSV row writes onto the created entity', () => {
    const { connector, view, created } = withCreatedWall();
    const matches = connector.match(connector.parse('GlobalId,FireRating\nguid-created,EI60'), MAPPING);
    const mutations = connector.generateMutations(matches, MAPPING);
    expect(mutations).toHaveLength(1);
    expect(view.getPropertyValue(created, 'Pset_WallCommon', 'FireRating')).toBe('EI60');
  });
});

/**
 * #5958: `generateMutations` used to collect its mutations in a local array
 * returned only at the end, while writing each one to the view as it went.
 * A transform (or `setProperty`) that threw partway left the earlier writes
 * in the view but out of `stats.mutations`, so the host could not record
 * them for undo.
 */
describe('CsvConnector: a mid-import throw keeps the applied writes (#5958)', () => {
  const rows = [1, 2, 3].map((n) => ({ expressId: n, globalId: `guid-${n}`, name: `Wall ${n}` }));
  const content = 'GlobalId,Code\nguid-1,A\nguid-2,BOOM\nguid-3,C';
  const mapping: DataMapping = {
    matchStrategy: { type: 'globalId', column: 'GlobalId' },
    propertyMappings: [{
      sourceColumn: 'Code',
      targetPset: 'Pset_Test',
      targetProperty: 'Code',
      valueType: PropertyValueType.Label,
      transform: (value) => {
        if (value === 'BOOM') throw new Error('transform failed');
        return value;
      },
    }],
  };

  it("['import'] reports every write that reached the view", () => {
    const { connector, view } = makeConnector(rows);
    const stats = connector['import'](content, mapping);

    expect(stats.errors).toEqual(['transform failed']);
    expect(view.getPropertyValue(1, 'Pset_Test', 'Code')).toBe('A');
    expect(stats.mutations.map((m) => m.entityId)).toEqual([1]);
    expect(stats.mutationsCreated).toBe(1);
  });

  it('importAsync reports them and hands each batch to onApplied, the failing one included', async () => {
    const { connector, view } = makeConnector(rows);
    const applied: number[][] = [];
    const stats = await connector.importAsync(content, mapping, () => {}, {
      batchSize: 1,
      onApplied: (mutations) => { applied.push(mutations.map((m) => m.entityId)); },
    });

    expect(stats.errors).toEqual(['transform failed']);
    expect(view.getPropertyValue(1, 'Pset_Test', 'Code')).toBe('A');
    expect(view.getPropertyValue(3, 'Pset_Test', 'Code')).toBeNull();
    expect(stats.mutations.map((m) => m.entityId)).toEqual([1]);
    expect(stats.mutationsCreated).toBe(1);
    expect(applied).toEqual([[1]]);
  });

  it('a throwing onApplied is reported and does not hide the import error', async () => {
    const { connector } = makeConnector(rows);
    const stats = await connector.importAsync(content, mapping, () => {}, {
      batchSize: 10,
      onApplied: () => { throw new Error('recorder failed'); },
    });
    expect(stats.errors).toEqual(['onApplied: recorder failed', 'transform failed']);
    expect(stats.mutations.map((m) => m.entityId)).toEqual([1]);
  });

  it('a partial batch before the throw still reaches onApplied', async () => {
    const { connector } = makeConnector(rows);
    const applied: number[][] = [];
    const stats = await connector.importAsync(content, mapping, () => {}, {
      batchSize: 10,
      onApplied: (mutations) => { applied.push(mutations.map((m) => m.entityId)); },
    });

    expect(stats.mutations.map((m) => m.entityId)).toEqual([1]);
    expect(applied).toEqual([[1]]);
  });
});
