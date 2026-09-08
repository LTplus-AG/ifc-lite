/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Closes a Major CodeRabbit finding against #2934/#3309: `attrIndex`
 * (`subset-entity-reader.ts`) used to resolve every positional slot against
 * `getAttributeNamesAcrossSchemas`, which tries the parser's PINNED
 * IFC4_ADD2_TC1 codegen registry FIRST and only falls back to the
 * cross-schema union when the pin does not know the type at all. For any
 * type the pin DOES know — most of them — that meant IFC4's attribute ORDER
 * was used regardless of what schema the exported model actually declared.
 *
 * `IfcApprovalRelationship.Name` is the reviewer's example, and this file
 * verifies it directly against the bundled schema tables before relying on
 * it (a hand comment can go stale; the data cannot):
 *   - IFC2X3: `["RelatedApproval","RelatingApproval","Description","Name"]`
 *     — `Name` is slot 3.
 *   - IFC4:   `["Name","Description","RelatingApproval","RelatedApprovals"]`
 *     — `Name` is slot 0.
 * `IfcApprovalRelationship` is not an `IfcRoot` descendant (no `GlobalId`),
 * so it is scrubbed by `pseudonymizeAllNames`'s NON-ROOT sweep
 * (`anonymize-scrub.ts`'s `pseudonymizeNonRootNames`, `NON_ROOT_NAME_ATTRIBUTES`)
 * — exactly the path the fix threads the source model's OWN schema through.
 *
 * Under the pre-fix behaviour, exporting the IFC2X3 fixture below reads
 * `record.args[0]` for `Name` — the `RelatedApproval` slot, `$` in this
 * fixture, not a quoted string — so `isQuotedStepString` rejects it and the
 * REAL name at slot 3 is silently left untouched: a privacy miss, not a
 * cosmetic one, exactly as the finding describes. This test fails under that
 * behaviour and passes once `attrIndex` resolves against `store.schemaVersion`.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { ENTITIES_IFC2X3, ENTITIES_IFC4 } from '@ifc-lite/data';
import { exportAnonymizedSubset } from './anonymize-export.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

describe('attrIndex resolves against the SOURCE model schema, not a pinned IFC4 order', () => {
  it('sanity check: IfcApprovalRelationship.Name really does sit at a different slot in IFC2X3 vs IFC4', () => {
    const ifc2x3 = ENTITIES_IFC2X3.find((e) => e.name === 'IfcApprovalRelationship');
    const ifc4 = ENTITIES_IFC4.find((e) => e.name === 'IfcApprovalRelationship');
    expect(ifc2x3?.attributes.indexOf('Name')).toBe(3);
    expect(ifc4?.attributes.indexOf('Name')).toBe(0);
  });

  it('pseudonymizes IfcApprovalRelationship.Name from an IFC2X3 source (slot 3, not the IFC4 slot-0 guess)', async () => {
    const secretName = 'Secret-Approver-Jane-Doe';
    const model = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('attr-index-source-schema-fixture.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project Public',$,$,$,$,$,$);
#9=IFCAPPROVALRELATIONSHIP($,$,'Approval note','${secretName}');
ENDSEC;
END-ISO-10303-21;`;

    const store = await parse(model);
    expect(store.schemaVersion).toBe('IFC2X3');

    // #9 is not an `IfcRoot` descendant, so it is only reachable through the
    // export at all by naming it directly — it becomes its own root (see
    // `getSubsetEntityIds`'s `includedIds.has(expressId)` branch).
    const result = exportAnonymizedSubset(store, new Set([1, 9]));
    const content = decode(result.content);

    expect(content).toContain('IFCAPPROVALRELATIONSHIP');
    expect(content, 'the real Name value must not survive the export').not.toContain(secretName);
    // Pseudonym shape from `nextPseudonym`: `<NormalizedType>-<n>`.
    expect(content).toMatch(/'IfcApprovalRelationship-1'/);
  });
});
