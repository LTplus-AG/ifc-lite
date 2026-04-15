/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for on-demand classification and material extraction
 */

import { describe, it, expect } from 'vitest';
import { extractClassificationsOnDemand, extractMaterialsOnDemand } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

/**
 * Helper: build a minimal IfcDataStore from STEP lines.
 * Each line should be a STEP entity like: #10=IFCMATERIAL('Concrete',$,$);
 */
function buildStoreFromStep(
  lines: string[],
  classificationMap?: Map<number, number[]>,
  materialMap?: Map<number, number>
): IfcDataStore {
  // Join lines and encode
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  // Parse entity refs from the lines
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const rawType = match[2];

      // Build proper type name (e.g., IFCMATERIAL -> IfcMaterial)
      const type = rawType;
      const lineBytes = new TextEncoder().encode(line);
      const byteOffset = source.indexOf(lineBytes[0], offset);
      // Find start of this line in source
      const lineStart = text.indexOf(line, offset > 0 ? text.indexOf('\n', offset - 1) : 0);

      const ref: EntityRef = {
        expressId,
        type,
        byteOffset: lineStart >= 0 ? lineStart : offset,
        byteLength: line.length,
        lineNumber: 1,
      };

      byId.set(expressId, ref);
      const typeUpper = type.toUpperCase();
      let typeList = byType.get(typeUpper);
      if (!typeList) {
        typeList = [];
        byType.set(typeUpper, typeList);
      }
      typeList.push(expressId);

      offset = lineStart >= 0 ? lineStart + line.length : offset + line.length;
    }
  }

  return {
    source,
    entityIndex: { byId, byType },
    onDemandClassificationMap: classificationMap,
    onDemandMaterialMap: materialMap,
  } as unknown as IfcDataStore;
}

// ============================================================================
// Classification Tests
// ============================================================================

describe('extractClassificationsOnDemand', () => {
  it('should return empty array when no classification map', () => {
    const store = buildStoreFromStep([]);
    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toEqual([]);
  });

  it('should return empty array when entity has no classifications', () => {
    const classMap = new Map<number, number[]>();
    const store = buildStoreFromStep([], classMap);
    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toEqual([]);
  });

  it('should extract IfcClassificationReference with identification and name', () => {
    const lines = [
      `#10=IFCCLASSIFICATIONREFERENCE('http://example.com','Pr_40_30','Walls',#20,'Wall classification',$);`,
      `#20=IFCCLASSIFICATION('CSI','2015',$,'Uniclass 2015',$,$,$);`,
    ];
    const classMap = new Map<number, number[]>([[100, [10]]]);
    const store = buildStoreFromStep(lines, classMap);

    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].identification).toBe('Pr_40_30');
    expect(result[0].name).toBe('Walls');
    expect(result[0].system).toBe('Uniclass 2015');
    expect(result[0].description).toBe('Wall classification');
  });

  it('should extract direct IfcClassification reference', () => {
    const lines = [
      `#30=IFCCLASSIFICATION('bSI','2015',$,'OmniClass','A classification system',$,$);`,
    ];
    const classMap = new Map<number, number[]>([[200, [30]]]);
    const store = buildStoreFromStep(lines, classMap);

    const result = extractClassificationsOnDemand(store, 200);
    expect(result).toHaveLength(1);
    expect(result[0].system).toBe('OmniClass');
    expect(result[0].name).toBe('OmniClass');
    expect(result[0].description).toBe('A classification system');
  });

  it('should walk classification chain to build path', () => {
    const lines = [
      `#10=IFCCLASSIFICATIONREFERENCE($,'Pr_40_30_10','External walls',#11,$,$);`,
      `#11=IFCCLASSIFICATIONREFERENCE($,'Pr_40_30','Walls',#12,$,$);`,
      `#12=IFCCLASSIFICATION('CSI','2015',$,'Uniclass 2015',$,$,$);`,
    ];
    const classMap = new Map<number, number[]>([[100, [10]]]);
    const store = buildStoreFromStep(lines, classMap);

    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].system).toBe('Uniclass 2015');
    expect(result[0].path).toEqual(['Pr_40_30']);
  });

  it('should handle multiple classifications on same entity', () => {
    const lines = [
      `#10=IFCCLASSIFICATIONREFERENCE($,'EF_25','Walls',#20,$,$);`,
      `#15=IFCCLASSIFICATIONREFERENCE($,'22-00-00','Openings',#25,$,$);`,
      `#20=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);`,
      `#25=IFCCLASSIFICATION($,$,$,'OmniClass',$,$,$);`,
    ];
    const classMap = new Map<number, number[]>([[100, [10, 15]]]);
    const store = buildStoreFromStep(lines, classMap);

    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toHaveLength(2);
    expect(result[0].system).toBe('Uniclass 2015');
    expect(result[1].system).toBe('OmniClass');
  });

  it('should handle missing referenced source gracefully', () => {
    const lines = [
      `#10=IFCCLASSIFICATIONREFERENCE($,'ABC123','Some ref',$,$,$);`,
    ];
    const classMap = new Map<number, number[]>([[100, [10]]]);
    const store = buildStoreFromStep(lines, classMap);

    const result = extractClassificationsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].identification).toBe('ABC123');
    expect(result[0].system).toBeUndefined();
  });
});

// ============================================================================
// Material Tests
// ============================================================================

describe('extractMaterialsOnDemand', () => {
  it('should return null when no material map', () => {
    const store = buildStoreFromStep([]);
    const result = extractMaterialsOnDemand(store, 100);
    expect(result).toBeNull();
  });

  it('should return null when entity has no material', () => {
    const matMap = new Map<number, number>();
    const store = buildStoreFromStep([], undefined, matMap);
    const result = extractMaterialsOnDemand(store, 100);
    expect(result).toBeNull();
  });

  it('should extract IfcMaterial (direct assignment)', () => {
    const lines = [
      `#10=IFCMATERIAL('Concrete','Structural concrete',$);`,
    ];
    const matMap = new Map<number, number>([[100, 10]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('Material');
    expect(result!.name).toBe('Concrete');
    expect(result!.description).toBe('Structural concrete');
  });

  it('should extract IfcMaterialLayerSet with layers', () => {
    const lines = [
      `#10=IFCMATERIAL('Brick',$,$);`,
      `#11=IFCMATERIAL('Insulation',$,$);`,
      `#20=IFCMATERIALLAYER(#10,0.1,$,$,$,$,$);`,
      `#21=IFCMATERIALLAYER(#11,0.05,$,$,$,$,$);`,
      `#30=IFCMATERIALLAYERSET((#20,#21),'Wall Layers',$);`,
    ];
    const matMap = new Map<number, number>([[100, 30]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('MaterialLayerSet');
    expect(result!.name).toBe('Wall Layers');
    expect(result!.layers).toHaveLength(2);
    expect(result!.layers![0].materialName).toBe('Brick');
    expect(result!.layers![0].thickness).toBe(0.1);
    expect(result!.layers![1].materialName).toBe('Insulation');
    expect(result!.layers![1].thickness).toBe(0.05);
  });

  it('should extract IfcMaterialProfileSet with profiles', () => {
    const lines = [
      `#10=IFCMATERIAL('Steel',$,$);`,
      `#20=IFCMATERIALPROFILE('HEB200',$,#10,#50,$,'Structural');`,
      `#30=IFCMATERIALPROFILESET('Steel Profiles',$,(#20),$);`,
    ];
    const matMap = new Map<number, number>([[100, 30]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('MaterialProfileSet');
    expect(result!.name).toBe('Steel Profiles');
    expect(result!.profiles).toHaveLength(1);
    expect(result!.profiles![0].materialName).toBe('Steel');
    expect(result!.profiles![0].name).toBe('HEB200');
    expect(result!.profiles![0].category).toBe('Structural');
  });

  it('should extract IfcMaterialConstituentSet with constituents', () => {
    const lines = [
      `#10=IFCMATERIAL('Concrete',$,$);`,
      `#11=IFCMATERIAL('Steel Reinforcement',$,$);`,
      `#20=IFCMATERIALCONSTITUENT('Main',$,#10,0.8,'Structural');`,
      `#21=IFCMATERIALCONSTITUENT('Rebar',$,#11,0.2,'Reinforcement');`,
      `#30=IFCMATERIALCONSTITUENTSET('RC Slab',$,(#20,#21));`,
    ];
    const matMap = new Map<number, number>([[100, 30]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('MaterialConstituentSet');
    expect(result!.name).toBe('RC Slab');
    expect(result!.constituents).toHaveLength(2);
    expect(result!.constituents![0].materialName).toBe('Concrete');
    expect(result!.constituents![0].fraction).toBe(0.8);
    expect(result!.constituents![0].category).toBe('Structural');
    expect(result!.constituents![1].materialName).toBe('Steel Reinforcement');
    expect(result!.constituents![1].fraction).toBe(0.2);
  });

  it('should extract IfcMaterialList', () => {
    const lines = [
      `#10=IFCMATERIAL('Wood',$,$);`,
      `#11=IFCMATERIAL('Glass',$,$);`,
      `#30=IFCMATERIALLIST((#10,#11));`,
    ];
    const matMap = new Map<number, number>([[100, 30]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('MaterialList');
    expect(result!.materials).toEqual(['Wood', 'Glass']);
  });

  it('should follow IfcMaterialLayerSetUsage to IfcMaterialLayerSet', () => {
    const lines = [
      `#10=IFCMATERIAL('Brick',$,$);`,
      `#20=IFCMATERIALLAYER(#10,0.2,$,$,$,$,$);`,
      `#30=IFCMATERIALLAYERSET((#20),'Single Brick Wall',$);`,
      `#40=IFCMATERIALLAYERSETUSAGE(#30,.AXIS2.,.POSITIVE.,0.0,$);`,
    ];
    const matMap = new Map<number, number>([[100, 40]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('MaterialLayerSet');
    expect(result!.name).toBe('Single Brick Wall');
    expect(result!.layers).toHaveLength(1);
    expect(result!.layers![0].materialName).toBe('Brick');
    expect(result!.layers![0].thickness).toBe(0.2);
  });

  it('should follow IfcMaterialProfileSetUsage to IfcMaterialProfileSet', () => {
    const lines = [
      `#10=IFCMATERIAL('Steel',$,$);`,
      `#20=IFCMATERIALPROFILE('IPE300',$,#10,$,$,$);`,
      `#30=IFCMATERIALPROFILESET('Beam Profile',$,(#20),$);`,
      `#40=IFCMATERIALPROFILESETUSAGE(#30,$,$);`,
    ];
    const matMap = new Map<number, number>([[100, 40]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('MaterialProfileSet');
    expect(result!.name).toBe('Beam Profile');
    expect(result!.profiles).toHaveLength(1);
    expect(result!.profiles![0].materialName).toBe('Steel');
  });

  it('should return null for unknown material entity type', () => {
    const lines = [
      `#10=IFCMATERIALPROPERTIES('props',$,$,$);`,
    ];
    const matMap = new Map<number, number>([[100, 10]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).toBeNull();
  });

  it('should handle missing material reference in layer', () => {
    const lines = [
      `#20=IFCMATERIALLAYER($,0.15,$,$,$,$,$);`,
      `#30=IFCMATERIALLAYERSET((#20),'Partial Layer Set',$);`,
    ];
    const matMap = new Map<number, number>([[100, 30]]);
    const store = buildStoreFromStep(lines, undefined, matMap);

    const result = extractMaterialsOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('MaterialLayerSet');
    expect(result!.layers).toHaveLength(1);
    expect(result!.layers![0].materialName).toBeUndefined();
    expect(result!.layers![0].thickness).toBe(0.15);
  });
});
