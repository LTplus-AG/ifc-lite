/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { CsvConnector, MutablePropertyView, type DataMapping } from '../src/index.js';

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
