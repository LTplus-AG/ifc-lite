/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for on-demand material property-set extraction and material usage
 * aggregation (issue #978). Material psets are attached to an IfcMaterial via
 * IfcMaterialProperties — not via IfcRelDefinesByProperties — so they must be
 * resolved by scanning *MaterialProperties entities, not onDemandPropertyMap.
 */

import { describe, it, expect } from 'vitest';
import {
  extractMaterialPropertiesOnDemand,
  extractMaterialPropertiesForMaterialId,
  buildMaterialUsageIndex,
  collectMaterialLeaves,
  resolveMaterialDefId,
} from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';

/** Build a minimal IfcDataStore from STEP lines + an element→material map.
 *  `definesByType` adds forward IfcRelDefinesByType edges (type → occurrences)
 *  so the type-level material expansion in buildMaterialUsageIndex is testable. */
function buildStore(
  lines: string[],
  materialMap?: Map<number, number>,
  definesByType?: Array<[number, number[]]>,
): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let cursor = 0;
  for (const line of lines) {
    const start = text.indexOf(line, cursor);
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];
      const ref: EntityRef = {
        expressId,
        type,
        byteOffset: start,
        byteLength: line.length,
        lineNumber: 1,
      };
      byId.set(expressId, ref);
      const typeUpper = type.toUpperCase();
      let list = byType.get(typeUpper);
      if (!list) { list = []; byType.set(typeUpper, list); }
      list.push(expressId);
    }
    cursor = start + line.length;
  }

  let relationships: unknown;
  if (definesByType) {
    const builder = new RelationshipGraphBuilder();
    let relId = 90000;
    for (const [typeId, occIds] of definesByType) {
      for (const occId of occIds) {
        builder.addEdge(typeId, occId, RelationshipType.DefinesByType, relId++);
      }
    }
    relationships = builder.build();
  }

  return {
    source,
    entityIndex: { byId, byType },
    onDemandMaterialMap: materialMap,
    relationships,
  } as unknown as IfcDataStore;
}

const FIXTURE = [
  `#1=IFCBEAM('g1',$,'Beam',$,$,$,$,$,$);`,
  `#2=IFCWALL('g2',$,'Wall',$,$,$,$,$,$);`,
  `#10=IFCMATERIAL('Concrete',$,'concrete');`,
  `#11=IFCMATERIAL('Insulation',$,'thermal');`,
  `#20=IFCPROPERTYSINGLEVALUE('Strength',$,30.0,$);`,
  `#21=IFCPROPERTYSINGLEVALUE('Grade',$,'C30/37',$);`,
  `#30=IFCMATERIALPROPERTIES('Pset_MaterialConcrete',$,(#20,#21),#10);`,
  `#25=IFCPROPERTYSINGLEVALUE('LambdaValue',$,0.035,$);`,
  `#31=IFCMATERIALPROPERTIES('Pset_MaterialThermal',$,(#25),#11);`,
  `#41=IFCMATERIALLAYER(#10,0.2,$,'Core',$,$,$);`,
  `#42=IFCMATERIALLAYER(#11,0.05,$,'Insul',$,$,$);`,
  `#40=IFCMATERIALLAYERSET((#41,#42),'Wall Buildup',$);`,
];

function fixtureStore(): IfcDataStore {
  // #1 (beam) → plain concrete material; #2 (wall) → a two-layer set
  return buildStore(FIXTURE, new Map<number, number>([[1, 10], [2, 40]]));
}

describe('extractMaterialPropertiesOnDemand', () => {
  it('resolves Pset_Material* on a direct material association', () => {
    const store = fixtureStore();
    const groups = extractMaterialPropertiesOnDemand(store, 1);

    expect(groups).toHaveLength(1);
    expect(groups[0].materialId).toBe(10);
    expect(groups[0].materialName).toBe('Concrete');
    expect(groups[0].psets).toHaveLength(1);
    expect(groups[0].psets[0].name).toBe('Pset_MaterialConcrete');
    const props = groups[0].psets[0].properties;
    expect(props.map((p) => p.name)).toEqual(['Strength', 'Grade']);
    expect(props.find((p) => p.name === 'Strength')!.value).toBe(30.0);
    expect(props.find((p) => p.name === 'Grade')!.value).toBe('C30/37');
  });

  it('fans out a layer set to each member material that has psets', () => {
    const store = fixtureStore();
    const groups = extractMaterialPropertiesOnDemand(store, 2);

    const byId = new Map(groups.map((g) => [g.materialId, g]));
    expect(byId.has(10)).toBe(true); // concrete
    expect(byId.has(11)).toBe(true); // insulation
    expect(byId.get(10)!.psets[0].name).toBe('Pset_MaterialConcrete');
    expect(byId.get(11)!.psets[0].name).toBe('Pset_MaterialThermal');
    expect(byId.get(11)!.psets[0].properties[0].name).toBe('LambdaValue');
  });

  it('returns [] when the element has no material association', () => {
    const store = fixtureStore();
    expect(extractMaterialPropertiesOnDemand(store, 999)).toEqual([]);
  });
});

describe('extractMaterialPropertiesForMaterialId', () => {
  it('resolves a material entity selected directly', () => {
    const store = fixtureStore();
    const groups = extractMaterialPropertiesForMaterialId(store, 11);
    expect(groups).toHaveLength(1);
    expect(groups[0].materialId).toBe(11);
    expect(groups[0].psets[0].name).toBe('Pset_MaterialThermal');
  });
});

describe('resolveMaterialDefId', () => {
  it('returns the directly-associated material definition id', () => {
    const store = fixtureStore();
    expect(resolveMaterialDefId(store, 1)).toBe(10);
    expect(resolveMaterialDefId(store, 2)).toBe(40);
    expect(resolveMaterialDefId(store, 999)).toBeUndefined();
  });
});

describe('collectMaterialLeaves', () => {
  it('returns a single leaf with weight 1 for a plain material', () => {
    const store = fixtureStore();
    const leaves = collectMaterialLeaves(store, 10);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ id: 10, name: 'Concrete', weight: 1 });
  });

  it('splits a layer set by layer thickness', () => {
    const store = fixtureStore();
    const leaves = collectMaterialLeaves(store, 40);
    const byId = new Map(leaves.map((l) => [l.id, l]));
    // 0.2 / 0.25 = 0.8 concrete, 0.05 / 0.25 = 0.2 insulation
    expect(byId.get(10)!.weight).toBeCloseTo(0.8, 6);
    expect(byId.get(11)!.weight).toBeCloseTo(0.2, 6);
  });
});

describe('IFC2x3 material properties', () => {
  const IFC2X3 = [
    `#3=IFCBEAM('g3',$,'SteelBeam',$,$,$,$,$,$);`,
    `#60=IFCMATERIAL('Steel S355',$,'metal');`,
    `#61=IFCPROPERTYSINGLEVALUE('YieldStrength',$,355.0,$);`,
    // IfcExtendedMaterialProperties: [Material, ExtendedProperties, Description, Name]
    `#62=IFCEXTENDEDMATERIALPROPERTIES(#60,(#61),'Mechanical','Pset_SteelGrade');`,
    // Typed IFC2x3 subtype with scalar fields and NO IfcProperty list — must be skipped, not mis-parsed.
    `#63=IFCMECHANICALMATERIALPROPERTIES(#60,1.2,210000.0,$);`,
  ];

  it('reads name + material from IfcExtendedMaterialProperties (Material at index 0)', () => {
    const store = buildStore(IFC2X3, new Map<number, number>([[3, 60]]));
    const groups = extractMaterialPropertiesForMaterialId(store, 60);
    expect(groups).toHaveLength(1);
    expect(groups[0].materialId).toBe(60);
    expect(groups[0].psets).toHaveLength(1);
    // Name lives at attr[3] in IFC2x3, not attr[0] (which is the Material ref).
    expect(groups[0].psets[0].name).toBe('Pset_SteelGrade');
    expect(groups[0].psets[0].properties[0].name).toBe('YieldStrength');
    expect(groups[0].psets[0].properties[0].value).toBe(355.0);
  });

  it('resolves the same psets through an element association', () => {
    const store = buildStore(IFC2X3, new Map<number, number>([[3, 60]]));
    const groups = extractMaterialPropertiesOnDemand(store, 3);
    expect(groups.map((g) => g.psets[0]?.name)).toContain('Pset_SteelGrade');
  });
});

describe('buildMaterialUsageIndex', () => {
  it('inverts the element→material map with volume weights', () => {
    const store = fixtureStore();
    const usage = buildMaterialUsageIndex(store);

    const concrete = usage.get(10)!;
    expect(concrete.name).toBe('Concrete');
    expect(concrete.ifcClass.toUpperCase()).toBe('IFCMATERIAL');
    // beam #1 (weight 1) + wall #2 concrete layer (weight 0.8)
    const concreteByEntity = new Map(concrete.entries.map((e) => [e.entityId, e.weight]));
    expect(concreteByEntity.get(1)).toBeCloseTo(1, 6);
    expect(concreteByEntity.get(2)).toBeCloseTo(0.8, 6);

    const insulation = usage.get(11)!;
    expect(insulation.entries).toHaveLength(1);
    expect(insulation.entries[0]).toMatchObject({ entityId: 2 });
    expect(insulation.entries[0].weight).toBeCloseTo(0.2, 6);
  });
});

// Issue #1755 — IfcRelAssociatesMaterial commonly targets the TYPE entity
// (IfcDoorType). The usage index must attribute those materials to the
// occurrences (types have no geometry, so the By Material tab filtered them
// out and the totals panel mis-attributed quantities).
describe('buildMaterialUsageIndex — type-level material expansion (#1755)', () => {
  // Doors #1/#2 typed by IfcDoorType #5; wall #3 with its own material.
  // Type #5 carries a two-constituent set (wood1/wood2).
  const TYPED = [
    `#1=IFCDOOR('d1',$,'Door',$,$,$,$,$,2.,0.9,$,$,$);`,
    `#2=IFCDOOR('d2',$,'Door',$,$,$,$,$,2.,0.9,$,$,$);`,
    `#3=IFCWALL('w1',$,'Wall',$,$,$,$,$,$);`,
    `#5=IFCDOORTYPE('t1',$,'DoorType',$,$,$,$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,$);`,
    `#10=IFCMATERIAL('wood1',$,$);`,
    `#11=IFCMATERIAL('wood2',$,$);`,
    `#12=IFCMATERIAL('Unknown',$,$);`,
    `#20=IFCMATERIALCONSTITUENT('Lining',$,#10,0.6,$);`,
    `#21=IFCMATERIALCONSTITUENT('Framing',$,#11,0.4,$);`,
    `#22=IFCMATERIALCONSTITUENTSET('Unnamed',$,(#20,#21));`,
  ];

  it('attributes a type-associated material to the occurrences, not the type', () => {
    const store = buildStore(
      TYPED,
      new Map([[5, 22], [3, 12]]),
      [[5, [1, 2]]],
    );
    const usage = buildMaterialUsageIndex(store);

    const wood1 = usage.get(10)!;
    expect(wood1.entries.map((e) => e.entityId).sort()).toEqual([1, 2]);
    for (const e of wood1.entries) expect(e.weight).toBeCloseTo(0.6, 6);

    const wood2 = usage.get(11)!;
    expect(wood2.entries.map((e) => e.entityId).sort()).toEqual([1, 2]);
    for (const e of wood2.entries) expect(e.weight).toBeCloseTo(0.4, 6);

    // The type entity itself must NOT appear (dead row in the tab, phantom
    // element in the totals panel).
    for (const u of usage.values()) {
      expect(u.entries.some((e) => e.entityId === 5)).toBe(false);
    }

    // Occurrence-level association untouched.
    expect(usage.get(12)!.entries).toEqual([{ entityId: 3, weight: 1 }]);
  });

  it('occurrence-level association overrides the type-level one (no double count)', () => {
    // Door #1 has its OWN material (wood2 direct); #2 inherits from the type.
    const store = buildStore(
      TYPED,
      new Map([[5, 22], [1, 11]]),
      [[5, [1, 2]]],
    );
    const usage = buildMaterialUsageIndex(store);

    // #1 appears exactly once across all usages — under its own wood2.
    const appearances: number[] = [];
    for (const u of usage.values()) {
      for (const e of u.entries) if (e.entityId === 1) appearances.push(u.id);
    }
    expect(appearances).toEqual([11]);
    expect(usage.get(11)!.entries.find((e) => e.entityId === 1)!.weight).toBeCloseTo(1, 6);

    // #2 still inherits both constituents from the type.
    expect(usage.get(10)!.entries.map((e) => e.entityId)).toEqual([2]);
  });

  it('per-occurrence weights across usages sum to ~1', () => {
    const store = buildStore(TYPED, new Map([[5, 22]]), [[5, [1, 2]]]);
    const usage = buildMaterialUsageIndex(store);
    for (const occId of [1, 2]) {
      let sum = 0;
      for (const u of usage.values()) {
        for (const e of u.entries) if (e.entityId === occId) sum += e.weight;
      }
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('a type with zero occurrences yields no entries (no dead rows)', () => {
    const store = buildStore(TYPED, new Map([[5, 22]]), [[5, []]]);
    const usage = buildMaterialUsageIndex(store);
    expect(usage.size).toBe(0);
  });

  it('keeps the verbatim type-keyed entry when the store has no relationship graph', () => {
    // Minimal stores (this harness without definesByType) have no graph —
    // fall back to the old behavior rather than dropping data.
    const store = buildStore(TYPED, new Map([[5, 22]]));
    const usage = buildMaterialUsageIndex(store);
    expect(usage.get(10)!.entries.map((e) => e.entityId)).toEqual([5]);
  });

  it('dedupes a double-typed occurrence (malformed duplicate DefinesByType edges)', () => {
    const store = buildStore(
      TYPED,
      new Map([[5, 22]]),
      [[5, [1, 1, 2]]],
    );
    const usage = buildMaterialUsageIndex(store);
    const wood1Ids = usage.get(10)!.entries.map((e) => e.entityId).sort();
    expect(wood1Ids).toEqual([1, 2]);
  });
});
