/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `checkPredefinedType`'s `case 'pattern'` (`packages/ids/src/audit/ifc-schema/index.ts`)
 * compiles an `xs:pattern` facet's pattern to test it against the
 * entity's known predefined types. This pins that a catastrophic
 * pattern is reported as its own `E_REGEX_UNSAFE` audit issue instead
 * of being compiled/run, and that an ordinary pattern still passes
 * through to the existing predefined-type check. See issue #4259.
 */

import { describe, expect, it } from 'vitest';
import { auditIDSDocument } from '../index.js';
import type { IDSAuditCode } from '../types.js';

const idsHeader = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Test IDS</title></info>
  <specifications>`;
const idsFooter = `  </specifications>
</ids>`;

function wrap(spec: string): string {
  return `${idsHeader}\n${spec}\n${idsFooter}`;
}

function codes(issues: { code: IDSAuditCode }[]): IDSAuditCode[] {
  return issues.map((i) => i.code);
}

function specWithPredefinedTypePattern(pattern: string): string {
  return wrap(`<specification name="PDT pattern" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
          <predefinedType>
            <xs:restriction base="xs:string">
              <xs:pattern value="${pattern}"/>
            </xs:restriction>
          </predefinedType>
        </entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
}

describe('IFC-schema audit — predefinedType pattern ReDoS guard', () => {
  it('reports E_REGEX_UNSAFE for a catastrophic-backtracking pattern, does not hang', async () => {
    const start = performance.now();
    const r = await auditIDSDocument(specWithPredefinedTypePattern('(a+)+b'));
    expect(codes(r.issues)).toContain('E_REGEX_UNSAFE');
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('does not flag an ordinary predefined-type pattern', async () => {
    // SOLIDWALL is a real IFC4 IfcWallTypeEnum value.
    const r = await auditIDSDocument(specWithPredefinedTypePattern('SOLID.*'));
    expect(codes(r.issues)).not.toContain('E_REGEX_UNSAFE');
  });
});
