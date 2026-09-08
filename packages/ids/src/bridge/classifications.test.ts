/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Non-rooted resources (IfcMaterial, IfcProfileDef, …) cannot carry
 * `IfcRelAssociatesClassification` — that relation targets `IfcRoot`
 * subtypes only. The only way such a resource gets a classification is
 * `IfcExternalReferenceRelationship` pointing at it from
 * `RelatedResourceObjects`, walked by
 * `appendExternalReferenceClassifications` in ./classifications.ts.
 *
 * Before this file, nothing exercised that walk anywhere in the package
 * (confirmed by grepping the suite for
 * `resolveClassifications|ExternalReferenceRelationship|IFCCLASSIFICATIONREFERENCE`
 * across every `*.test.ts` — zero hits). A broken walk would silently
 * under- or over-match classification facets against materials.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';

async function accessorFor(ifc: string) {
  const store = await new IfcParser().parseColumnar(
    new TextEncoder().encode(ifc).buffer,
    { disableWorkerScan: true },
  );
  return createDataAccessor(store);
}

const HEADER = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;`;
const FOOTER = `ENDSEC;
END-ISO-10303-21;`;

describe('resolveClassifications: IfcExternalReferenceRelationship walk for non-rooted resources', () => {
  it('resolves a material classified through IfcExternalReferenceRelationship', async () => {
    const ifc = `${HEADER}
#10=IFCMATERIAL('Concrete C30/37',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'Pr_20_93_08','Concrete',#22,$,$);
#22=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    expect(classifications).toEqual([
      { system: 'Uniclass 2015', value: 'Pr_20_93_08', name: 'Concrete' },
    ]);
  });

  it('yields nothing for a resource with no IfcExternalReferenceRelationship (negative control)', async () => {
    const ifc = `${HEADER}
#10=IFCMATERIAL('Uncoated Material',$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    expect(a.getClassifications(10)).toEqual([]);
  });

  it('walks a multi-hop reference chain and exposes both the leaf and the parent code', async () => {
    // Leaf reference #21 ('25.10.25') points to an intermediate reference
    // #23 ('25.10'), which points to the terminal IfcClassification #22.
    // A requirement against the parent code '25.10' must still match a
    // material classified at the leaf '25.10.25' (this is exactly the
    // EF_25_10 / EF_25_10_25 case documented on resolveClassifications).
    const ifc = `${HEADER}
#10=IFCMATERIAL('Steel S355',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'25.10.25','Structural steel',#23,$,$);
#23=IFCCLASSIFICATIONREFERENCE($,'25.10','Steel',#22,$,$);
#22=IFCCLASSIFICATION($,$,$,'Uniclass 2015',$,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    expect(classifications).toEqual([
      { system: 'Uniclass 2015', value: '25.10.25', name: 'Structural steel' },
      { system: 'Uniclass 2015', value: '25.10', name: 'Structural steel' },
    ]);
  });

  it('terminates on a cyclic reference chain without hanging or duplicating', async () => {
    // #21 references #23, #23 references back to #21 — no IfcClassification
    // is ever reached, so `system` stays undefined, but the cycle guard
    // must stop the walk after each id is visited once.
    const ifc = `${HEADER}
#10=IFCMATERIAL('Cyclic Material',$,$);
#20=IFCEXTERNALREFERENCERELATIONSHIP($,$,#21,(#10));
#21=IFCCLASSIFICATIONREFERENCE($,'A','RefA',#23,$,$);
#23=IFCCLASSIFICATIONREFERENCE($,'B','RefB',#21,$,$);
${FOOTER}`;
    const a = await accessorFor(ifc);
    const classifications = a.getClassifications(10);
    // Exactly one IfcExternalReferenceRelationship touches #10, so exactly
    // one ClassRecord is produced regardless of how many nodes the cycle
    // visits — a broken guard would either hang (infinite loop) or, if the
    // node were re-added to the output list on each revisit, duplicate.
    expect(classifications).toEqual([
      { system: '', value: 'A', name: 'RefA' },
      { system: '', value: 'B', name: 'RefA' },
    ]);
  });
});
