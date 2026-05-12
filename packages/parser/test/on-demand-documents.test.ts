/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for on-demand document extraction
 */

import { describe, it, expect } from 'vitest';
import { extractDocumentsOnDemand } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';
import { RelationshipType } from '@ifc-lite/data';

/**
 * Helper: build a minimal IfcDataStore from STEP lines with document/relationship support.
 */
function buildStoreFromStep(
  lines: string[],
  opts?: {
    documentMap?: Map<number, number[]>;
    relationships?: { entityId: number; relType: RelationshipType; direction: 'forward' | 'inverse'; targetIds: number[] }[];
  }
): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];
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

  const relData = opts?.relationships ?? [];
  const relationships = {
    getRelated: (entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse') => {
      const matching = relData.filter(
        r => r.entityId === entityId && r.relType === relType && r.direction === direction
      );
      return matching.flatMap(r => r.targetIds);
    },
    hasRelationship: () => false,
    getRelationshipsBetween: () => [],
  };

  return {
    source,
    entityIndex: { byId, byType },
    onDemandDocumentMap: opts?.documentMap,
    relationships,
  } as unknown as IfcDataStore;
}

describe('extractDocumentsOnDemand', () => {
  it('should return empty array when no document map', () => {
    const store = buildStoreFromStep([]);
    (store as any).relationships = undefined;
    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toEqual([]);
  });

  it('should return empty array when entity has no documents', () => {
    const docMap = new Map<number, number[]>();
    const store = buildStoreFromStep([], { documentMap: docMap });
    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toEqual([]);
  });

  it('should extract IfcDocumentReference with basic fields', () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://docs.example.com/manual.pdf','DOC-001','Installation Manual','Technical installation guide',$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10]]]);
    const store = buildStoreFromStep(lines, { documentMap: docMap });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].location).toBe('http://docs.example.com/manual.pdf');
    expect(result[0].identification).toBe('DOC-001');
    expect(result[0].name).toBe('Installation Manual');
    expect(result[0].description).toBe('Technical installation guide');
  });

  it('should walk chain to IfcDocumentInformation', () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://docs.example.com/spec.pdf','DOC-002','Fire Spec',$,#20);`,
      `#20=IFCDOCUMENTINFORMATION('DOC-002-FULL','Fire Safety Specification','Detailed fire safety requirements','http://archive.example.com/spec.pdf','Fire Safety','Design Reference',$,'Rev 2.1',$,$,$,$,$,$,$,$,$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10]]]);
    const store = buildStoreFromStep(lines, { documentMap: docMap });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    // DocRef fields take precedence
    expect(result[0].location).toBe('http://docs.example.com/spec.pdf');
    expect(result[0].identification).toBe('DOC-002');
    expect(result[0].name).toBe('Fire Spec');
    // DocInfo fills in missing fields
    expect(result[0].purpose).toBe('Fire Safety');
    expect(result[0].intendedUse).toBe('Design Reference');
    expect(result[0].revision).toBe('Rev 2.1');
  });

  it('should handle direct IfcDocumentInformation reference', () => {
    const lines = [
      `#10=IFCDOCUMENTINFORMATION('SPEC-001','Building Specification','Main specification document','http://example.com/spec.pdf','Compliance','Construction',$,'Rev 1.0',$,$,$,$,$,$,$,$,$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10]]]);
    const store = buildStoreFromStep(lines, { documentMap: docMap });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].identification).toBe('SPEC-001');
    expect(result[0].name).toBe('Building Specification');
    expect(result[0].description).toBe('Main specification document');
    expect(result[0].purpose).toBe('Compliance');
    expect(result[0].intendedUse).toBe('Construction');
    expect(result[0].revision).toBe('Rev 1.0');
  });

  it('should extract type-level documents via relationship graph', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      `#200=IFCWALLTYPE('guid2',$,'Wall Type A',$,$,$,$,$,$,.STANDARD.);`,
      `#10=IFCDOCUMENTREFERENCE('http://example.com/wall-guide.pdf','WG-001','Wall Guide',$,$);`,
    ];
    const docMap = new Map<number, number[]>([
      [200, [10]], // Document on the type, not the instance
    ]);
    const store = buildStoreFromStep(lines, {
      documentMap: docMap,
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Wall Guide');
  });

  it('should handle multiple documents on one entity', () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://docs.example.com/manual.pdf','DOC-001','Manual',$,$);`,
      `#20=IFCDOCUMENTREFERENCE('http://docs.example.com/spec.pdf','DOC-002','Specification',$,$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10, 20]]]);
    const store = buildStoreFromStep(lines, { documentMap: docMap });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Manual');
    expect(result[1].name).toBe('Specification');
  });

  it('should fallback to relationship graph when no on-demand map', () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://example.com/doc.pdf','D-001','Doc',$,$);`,
    ];
    const store = buildStoreFromStep(lines, {
      relationships: [
        { entityId: 100, relType: RelationshipType.AssociatesDocument, direction: 'inverse', targetIds: [10] },
      ],
    });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Doc');
  });
});
