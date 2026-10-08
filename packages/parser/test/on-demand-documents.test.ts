/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for on-demand document extraction
 */

import { describe, it, expect } from 'vitest';
import { extractDocumentsOnDemand } from '../src/columnar-parser.js';
import { IfcParser } from '../src/index.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import { RelationshipType } from '@ifc-lite/data';

/**
 * Parse document and relationship STEP records through the actual load path
 * (#7187). The old source/index-only cast omitted required IfcDataStore methods.
 * These fixtures state document decoding invariants; the real authoring-tool
 * public-writer/export controls live in the native viewer document tests.
 */
async function buildStoreFromStep(
  lines: string[],
  opts?: {
    documentMap?: Map<number, number[]>;
    relationships?: { entityId: number; relType: RelationshipType; direction: 'forward' | 'inverse'; targetIds: number[] }[];
  }
): Promise<IfcDataStore> {
  const entities = [
    "#9000=IFCPROJECT('0000000000000000009000',$,'Document fixture',$,$,$,$,$,#9001);",
    "#9001=IFCUNITASSIGNMENT((#9002));",
    "#9002=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
    ...lines,
  ];
  const ids = new Set(lines.flatMap(line => {
    const match = /^#(\d+)=/.exec(line);
    return match ? [Number(match[1])] : [];
  }));
  const globalId = (id: number): string => id.toString().padStart(22, '0');
  const subjects = new Set([100, ...(opts?.documentMap?.keys() ?? []),
    ...(opts?.relationships ?? []).map(row => row.entityId)]);
  for (const id of subjects) {
    if (!ids.has(id)) entities.push(`#${id}=IFCWALL('${globalId(id)}',$,'Fixture wall',$,$,$,$,$,$);`);
  }
  let relationshipId = 10000;
  const association = (type: string, subject: number, target: number) => {
    const id = relationshipId++;
    entities.push(`#${id}=${type}('${globalId(id)}',$,$,$,(#${subject}),#${target});`);
  };
  for (const [subject, documents] of opts?.documentMap ?? []) {
    for (const document of documents) association('IFCRELASSOCIATESDOCUMENT', subject, document);
  }
  for (const relation of opts?.relationships ?? []) {
    if (relation.direction !== 'inverse') throw new Error('This fixture requires inverse object assignments');
    const type = relation.relType === RelationshipType.DefinesByType ? 'IFCRELDEFINESBYTYPE'
      : relation.relType === RelationshipType.AssociatesDocument ? 'IFCRELASSOCIATESDOCUMENT' : null;
    if (!type) throw new Error('This fixture supports document and defining-type assignments');
    for (const target of relation.targetIds) association(type, relation.entityId, target);
  }
  const source = new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;', "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', ...entities, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n'));
  const store = await new IfcParser().parseColumnar(source.buffer, { disableWorkerScan: true });
  // Exercise the documented graph path by removing only the optional map;
  // the actual required relationship graph and entity reader remain intact.
  if (!opts?.documentMap) store.onDemandDocumentMap = undefined;
  return store;
}

describe('extractDocumentsOnDemand', () => {
  it('should return empty array when no document map', async () => {
    const store = await buildStoreFromStep([]);
    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toEqual([]);
  });

  it('should return empty array when entity has no documents', async () => {
    const docMap = new Map<number, number[]>();
    const store = await buildStoreFromStep([], { documentMap: docMap });
    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toEqual([]);
  });

  it('should extract IfcDocumentReference with basic fields', async () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://docs.example.com/manual.pdf','DOC-001','Installation Manual','Technical installation guide',$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10]]]);
    const store = await buildStoreFromStep(lines, { documentMap: docMap });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].location).toBe('http://docs.example.com/manual.pdf');
    expect(result[0].identification).toBe('DOC-001');
    expect(result[0].name).toBe('Installation Manual');
    expect(result[0].description).toBe('Technical installation guide');
  });

  it('should walk chain to IfcDocumentInformation', async () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://docs.example.com/spec.pdf','DOC-002','Fire Spec',$,#20);`,
      `#20=IFCDOCUMENTINFORMATION('DOC-002-FULL','Fire Safety Specification','Detailed fire safety requirements','http://archive.example.com/spec.pdf','Fire Safety','Design Reference',$,'Rev 2.1',$,$,$,$,$,$,$,$,$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10]]]);
    const store = await buildStoreFromStep(lines, { documentMap: docMap });

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

  it('should handle direct IfcDocumentInformation reference', async () => {
    const lines = [
      `#10=IFCDOCUMENTINFORMATION('SPEC-001','Building Specification','Main specification document','http://example.com/spec.pdf','Compliance','Construction',$,'Rev 1.0',$,$,$,$,$,$,$,$,$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10]]]);
    const store = await buildStoreFromStep(lines, { documentMap: docMap });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].identification).toBe('SPEC-001');
    expect(result[0].name).toBe('Building Specification');
    expect(result[0].description).toBe('Main specification document');
    expect(result[0].purpose).toBe('Compliance');
    expect(result[0].intendedUse).toBe('Construction');
    expect(result[0].revision).toBe('Rev 1.0');
  });

  it('should extract type-level documents via relationship graph', async () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      `#200=IFCWALLTYPE('guid2',$,'Wall Type A',$,$,$,$,$,$,.STANDARD.);`,
      `#10=IFCDOCUMENTREFERENCE('http://example.com/wall-guide.pdf','WG-001','Wall Guide',$,$);`,
    ];
    const docMap = new Map<number, number[]>([
      [200, [10]], // Document on the type, not the instance
    ]);
    const store = await buildStoreFromStep(lines, {
      documentMap: docMap,
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Wall Guide');
  });

  it('should handle multiple documents on one entity', async () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://docs.example.com/manual.pdf','DOC-001','Manual',$,$);`,
      `#20=IFCDOCUMENTREFERENCE('http://docs.example.com/spec.pdf','DOC-002','Specification',$,$);`,
    ];
    const docMap = new Map<number, number[]>([[100, [10, 20]]]);
    const store = await buildStoreFromStep(lines, { documentMap: docMap });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Manual');
    expect(result[1].name).toBe('Specification');
  });

  it('should fallback to relationship graph when no on-demand map', async () => {
    const lines = [
      `#10=IFCDOCUMENTREFERENCE('http://example.com/doc.pdf','D-001','Doc',$,$);`,
    ];
    const store = await buildStoreFromStep(lines, {
      relationships: [
        { entityId: 100, relType: RelationshipType.AssociatesDocument, direction: 'inverse', targetIds: [10] },
      ],
    });

    const result = extractDocumentsOnDemand(store, 100);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Doc');
  });
});
