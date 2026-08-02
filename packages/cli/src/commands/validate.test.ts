/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reference-integrity validation rule: `#N` references that point at an
 * expressId with no entity in the file must be reported (per referencing
 * entity, attribute slot, and missing target), while `#N`-looking sequences
 * inside string literals must not. Proven gap: a text scan caught planted
 * dangling refs that `ifc-lite validate` missed entirely.
 *
 * Regression suite for PR #1868 (world-gym benchmark surfaced the gap: the
 * kernel-oracle baseline scored F1=0 on 94 planted dangling refs).
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { computeValidationIssues, collectDanglingReferences } from './validate.js';

function buildIfc(dataLines: string[]): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function parse(content: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(content);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer);
}

const CLEAN_LINES = [
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,$,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,$,$,$,$);",
  "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
  // Name contains '#123' and an escaped quote before '#77': neither is a reference.
  "#5=IFCWALL('0Wall_GUID_00000001',$,'It''s wall #123 and #77',$,$,$,$,$,$);",
  '#6=IFCRELAGGREGATES(\'0RelAgg_GUID_000001\',$,$,$,#1,(#2,#3));',
];

const DANGLING_LINES = [
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,$,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,$,$,$,$);",
  "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
  // OwnerHistory (attribute slot 1) points at #9999, which does not exist.
  "#5=IFCWALL('0Wall_GUID_00000001',#9999,'Wall #123',$,$,$,$,$,$);",
  // RelatedObjects list (attribute slot 5) contains dangling #8888.
  '#6=IFCRELAGGREGATES(\'0RelAgg_GUID_000001\',$,$,$,#1,(#2,#8888));',
];

describe('collectDanglingReferences', () => {
  it('finds each dangling reference with entity id, attribute slot, and missing target', async () => {
    const store = await parse(buildIfc(DANGLING_LINES));
    const dangling = collectDanglingReferences(store)
      .sort((a, b) => a.entityId - b.entityId);

    expect(dangling).toHaveLength(2);
    expect(dangling[0]).toMatchObject({
      entityId: 5,
      entityType: 'IFCWALL',
      attributeIndex: 1,
      target: 9999,
    });
    expect(dangling[1]).toMatchObject({
      entityId: 6,
      entityType: 'IFCRELAGGREGATES',
      attributeIndex: 5,
      target: 8888,
    });
  });

  it('reports nothing on a clean file (and ignores #N inside string literals)', async () => {
    const store = await parse(buildIfc(CLEAN_LINES));
    expect(collectDanglingReferences(store)).toHaveLength(0);
  });
});

describe('computeValidationIssues reference-integrity rule', () => {
  it('emits one error per dangling reference and flips the file invalid', async () => {
    const store = await parse(buildIfc(DANGLING_LINES));
    const issues = computeValidationIssues(store);
    const refIssues = issues.filter(i => i.rule === 'reference-integrity');

    expect(refIssues).toHaveLength(2);
    for (const issue of refIssues) {
      expect(issue.severity).toBe('error');
      expect(issue.message).toContain('references missing entity');
    }
    // Display names render in IFC PascalCase, not the raw STEP token.
    expect(refIssues.map(i => i.message).join('\n')).toContain('IfcWall');
    expect(refIssues.map(i => i.message).join('\n')).not.toContain('IFCWALL');
    const targets = refIssues.map(i => i.target).sort();
    expect(targets).toEqual([8888, 9999]);
    // Errors present means the validate command reports the file as invalid.
    expect(issues.some(i => i.severity === 'error')).toBe(true);
  });

  it('stays quiet on the clean twin', async () => {
    const store = await parse(buildIfc(CLEAN_LINES));
    const issues = computeValidationIssues(store);
    expect(issues.filter(i => i.rule === 'reference-integrity')).toHaveLength(0);
  });
});
