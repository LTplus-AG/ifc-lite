/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `quantity-completeness` must count an element by whether it has quantities,
 * not by whether it has a named `IfcElementQuantity`.
 *
 * `Quantities` is `SET [1:?] OF IfcPhysicalQuantity` in IFC4 and IFC4X3, so an
 * empty set is non-conformant. Before #3259 the parser's instance path surfaced
 * one anyway, and this rule counted its element as quantified: a file where
 * every element carried an empty named set reported no completeness issue at
 * all, because `withoutQuantities` stayed at zero and the rule never fired.
 *
 * The fixture pairs the empty set with a POPULATED one on a second element, so
 * a regression that stopped reporting quantities altogether would flip the
 * count the other way and still fail here.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { computeValidationIssues } from './validate.js';

const IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);",
  "#10=IFCWALLSTANDARDCASE('0Wall_Empty_00000001',#1,'Wall Empty',$,$,$,$,$);",
  "#11=IFCWALLSTANDARDCASE('0Wall_Full_000000001',#1,'Wall Full',$,$,$,$,$);",
  "#20=IFCQUANTITYLENGTH('NetWidth',$,$,0.25,$);",
  "#30=IFCELEMENTQUANTITY('0Qto_Empty_00000001',#1,'Qto_Empty',$,$,());",
  "#31=IFCELEMENTQUANTITY('0Qto_Full_000000001',#1,'Qto_WallBaseQuantities',$,$,(#20));",
  "#40=IFCRELDEFINESBYPROPERTIES('0Rel_Empty_00000001',#1,$,$,(#10),#30);",
  "#41=IFCRELDEFINESBYPROPERTIES('0Rel_Full_000000001',#1,$,$,(#11),#31);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

async function parse(content: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(content);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer);
}

describe('quantity-completeness (#3259)', () => {
  it('counts an element carrying only an empty named quantity set as unquantified', async () => {
    const issues = computeValidationIssues(await parse(IFC));
    const completeness = issues.filter((i) => i.rule === 'quantity-completeness');

    expect(completeness).toHaveLength(1);
    // One of the two walls — the one whose only set is empty — is missing
    // quantities; the populated control keeps the denominator at 2.
    expect(completeness[0].message).toContain('1/2 building elements (50%)');
  });
});
