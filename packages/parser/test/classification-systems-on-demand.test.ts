/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for extractClassificationSystemsOnDemand — the cheap, exact,
 * per-model listing of distinct IfcClassification system names (as opposed
 * to extractClassificationsOnDemand, which resolves classifications for a
 * single entity by walking the reference chain).
 */

import { describe, it, expect } from 'vitest';
import { extractClassificationSystemsOnDemand } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

/** Helper: build a minimal IfcDataStore from STEP lines (mirrors the
 * on-demand-classification-material.test.ts helper). */
function buildStoreFromStep(lines: string[]): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  // EntityExtractor reads ref.byteOffset/byteLength as UTF-8 byte ranges
  // into `source` (a Uint8Array), so this fixture must compute them in
  // bytes -- not JS string length/indexOf, which count UTF-16 code units
  // and silently misalign every entity after a non-ASCII line.
  let byteOffset = 0;
  for (const line of lines) {
    const lineBytes = new TextEncoder().encode(line);
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];

      const ref: EntityRef = {
        expressId,
        type,
        byteOffset,
        byteLength: lineBytes.byteLength,
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
    }

    // +1 for the '\n' joining this line to the next.
    byteOffset += lineBytes.byteLength + 1;
  }

  return {
    source,
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

describe('extractClassificationSystemsOnDemand', () => {
  it('returns an empty array when the model has no IfcClassification entities', () => {
    const store = buildStoreFromStep([
      `#10=IFCWALL('guid',$,$,$,$,$,$,$,$);`,
    ]);
    expect(extractClassificationSystemsOnDemand(store)).toEqual([]);
  });

  it('surfaces ALL classification systems present, not just the first', () => {
    // A model carrying three systems at once — Uniclass, OmniClass, and a
    // national system (DIN 276) — must report all three, sorted.
    const lines = [
      `#10=IFCCLASSIFICATION('CSI','2015',$,'Uniclass 2015',$,$,$);`,
      `#11=IFCCLASSIFICATION('CSI','2018',$,'OmniClass',$,$,$);`,
      `#12=IFCCLASSIFICATION($,$,$,'DIN 276',$,$,$);`,
    ];
    const store = buildStoreFromStep(lines);
    expect(extractClassificationSystemsOnDemand(store)).toEqual([
      'DIN 276',
      'OmniClass',
      'Uniclass 2015',
    ]);
  });

  it('de-duplicates repeated system names', () => {
    const lines = [
      `#10=IFCCLASSIFICATION('CSI','2015',$,'Uniclass 2015',$,$,$);`,
      `#11=IFCCLASSIFICATION('CSI','2015',$,'Uniclass 2015',$,$,$);`,
    ];
    const store = buildStoreFromStep(lines);
    expect(extractClassificationSystemsOnDemand(store)).toEqual(['Uniclass 2015']);
  });

  it('skips IfcClassification entities with no name', () => {
    const lines = [
      `#10=IFCCLASSIFICATION($,$,$,$,$,$,$);`,
    ];
    const store = buildStoreFromStep(lines);
    expect(extractClassificationSystemsOnDemand(store)).toEqual([]);
  });

  it('reads the second entity correctly when an earlier line contains non-ASCII bytes', () => {
    // 'ß' is 1 UTF-16 code unit but 2 UTF-8 bytes, so a fixture that derives
    // byteOffset/byteLength from JS string length (rather than actual UTF-8
    // byte length) misaligns every entity after this line.
    const lines = [
      `#10=IFCCLASSIFICATION('CSI','2015',$,'Straße Norm',$,$,$);`,
      `#11=IFCCLASSIFICATION('CSI','2018',$,'OmniClass',$,$,$);`,
    ];
    const store = buildStoreFromStep(lines);
    expect(extractClassificationSystemsOnDemand(store)).toEqual([
      'OmniClass',
      'Straße Norm',
    ]);
  });
});
