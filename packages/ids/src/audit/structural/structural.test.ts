/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { auditIDSDocument } from '../index.js';
import type { IDSAuditCode } from '../types.js';

const codes = (issues: { code: IDSAuditCode }[]) => issues.map((i) => i.code);

const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Test</title></info>
  <specifications>`;
const FOOTER = `  </specifications>
</ids>`;

const wrap = (s: string) => `${HEADER}\n${s}\n${FOOTER}`;

describe('structural audit — XSD shape walker', () => {
  it('flags an unexpected attribute on a known element', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity invalidAttribute="bogus"><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(r.status).toBe('error');
    expect(codes(r.issues)).toContain('E_XSD_STRUCTURE');
  });

  it('flags an unexpected child element inside a facet', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
          <bogus />
        </entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_XSD_STRUCTURE');
  });

  it('flags an unexpected XSD-namespaced child', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name>
            <xs:restriction base="xs:string">
              <xs:bogusFacet value="..." />
            </xs:restriction>
          </name>
        </entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(codes(r.issues)).toContain('E_XSD_STRUCTURE');
  });

  it('passes a clean document with no extra attributes/elements', async () => {
    const xml = wrap(`<specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>`);
    const r = await auditIDSDocument(xml);
    expect(r.status).toBe('valid');
  });

  it('tolerates xmlns declarations and xsi:schemaLocation on root', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info><title>X</title></info>
  <specifications>
    <specification name="X" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;
    const r = await auditIDSDocument(xml);
    expect(r.status).toBe('valid');
  });
});
