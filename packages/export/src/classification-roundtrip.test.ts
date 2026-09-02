/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wall classified via `IfcClassificationReference` /
 * `IfcRelAssociatesClassification` (Uniclass 2015, `Pr_20_93_47`) must
 * survive STEP -> IFCX (IFC5) export AND a subsequent import through
 * `@ifc-lite/ifcx` (the primary IFCX reader — the round-trip fidelity
 * oracle, see AGENTS.md's classification lens): the classification is a
 * real source-model attribute, not derived geometry, so dropping it at
 * either end is metadata loss.
 *
 * This does a full write-then-read round trip, not just an assertion on
 * the exporter's JSON output: `Ifc5Exporter.export()` alone writing
 * `ifclite::classifications` would still leave the classification lost on
 * re-import, because `property-extractor.ts`'s `groupAttributesByNamespace`
 * treated every `ifclite::*` key as an internal, never-surfaced carrier
 * (#1031) — including this one, which (unlike `bsi::ifc::material`, #3605)
 * has no spec-defined IFCX home to unpack from instead. `#3608` unpacks
 * `ifclite::classifications` into a per-system "Classification" pset in
 * the reader specifically, so a plain (non-collab) re-import of the
 * exported file resolves the classification through `parsed.properties`,
 * the same table every other property comes back through.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { parseIfcx, IFCLITE_ATTR } from '@ifc-lite/ifcx';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('test','2023-01-17T16:18:54+01:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCORGANIZATION($,'Org',$,$,$);
#2=IFCAPPLICATION(#1,'1','App','App');
#3=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCPERSON($,'Author','IFC',(),$,$,$,$);
#16=IFCORGANIZATION($,'TestOrg','',$,$);
#17=IFCPERSONANDORGANIZATION(#15,#16,$);
#18=IFCOWNERHISTORY(#17,#2,$,.NOCHANGE.,$,$,$,1673968733);
#19=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#82=IFCUNITASSIGNMENT((#19));
#83=IFCAXIS2PLACEMENT3D(#3,$,$);
#85=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#83,$);
#90=IFCPROJECT('3k3rYVmQDDW90hT9pdtv9K',#18,'Project',$,$,$,$,(#85),#82);
#92=IFCAXIS2PLACEMENT3D(#3,$,$);
#112=IFCLOCALPLACEMENT($,#92);
#95=IFCBUILDING('3k3rYVmQDDW90hT9pdtv9L',#18,'TestBuilding',$,$,#112,$,'TestBuilding',.ELEMENT.,$,$,$);
#119=IFCLOCALPLACEMENT(#112,#92);
#139=IFCWALL('3DqaUydM99ehywE4_2hm1u',#18,'Wall-001',$,'Wall',#119,$,'2270026',.NOTDEFINED.);
#200=IFCCLASSIFICATION('BuildingSmart','2015',$,'Uniclass 2015',$,'https://uniclass.thenbs.com',$);
#201=IFCCLASSIFICATIONREFERENCE('https://uniclass.thenbs.com/Pr_20_93_47','Pr_20_93_47','Wall products',#200,$,$);
#202=IFCRELASSOCIATESCLASSIFICATION('3k3rYVmQDDW90hT9pdtv9Z',#18,$,$,(#139),#201);
#300=IFCRELAGGREGATES('3k3rYVmQDDW90hT9pdtv9A',#18,$,$,#95,(#139));
#301=IFCRELAGGREGATES('3k3rYVmQDDW90hT9pdtv9B',#18,$,$,#90,(#95));
ENDSEC;
END-ISO-10303-21;`;

describe('classification survives STEP -> IFCX export -> @ifc-lite/ifcx re-import', () => {
  it('exports the wall\'s Uniclass classification, and the ifcx reader resolves it back as a property', async () => {
    const store = await parse(MODEL);
    const exporter = new Ifc5Exporter(store);
    const result = exporter.export({ onlyTreeEntities: false, includeGeometry: false });

    // Write side: the attribute is on the wall's node in the emitted JSON.
    const doc = JSON.parse(result.content);
    const wallNode = doc.data.find(
      (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall-001',
    );
    expect(wallNode).toBeDefined();
    expect(wallNode.attributes?.[IFCLITE_ATTR.CLASSIFICATIONS]).toEqual([
      expect.objectContaining({ system: 'Uniclass 2015', code: 'Pr_20_93_47' }),
    ]);

    // Read side: re-import the exported IFCX through the real reader
    // (`@ifc-lite/ifcx`'s `parseIfcx`, not a re-parse of the same JSON) and
    // resolve the classification through the ordinary PropertyTable path —
    // the one every other IFCX-derived property (Name, psets, ...) comes
    // back through.
    const reparsed = await parseIfcx(
      new TextEncoder().encode(result.content).buffer as ArrayBuffer,
    );
    const { entities, strings } = reparsed;
    let wallExpressId: number | undefined;
    for (let i = 0; i < entities.count; i++) {
      if (strings.get(entities.name[i]) === 'Wall-001') {
        wallExpressId = entities.expressId[i];
        break;
      }
    }
    expect(wallExpressId).toBeDefined();

    const psets = reparsed.properties.getForEntity(wallExpressId!);
    const classificationPset = psets.find((p) => p.name === 'Classification - Uniclass 2015');
    expect(classificationPset).toBeDefined();
    const code = classificationPset!.properties.find((p) => p.name === 'Code');
    expect(code?.value).toBe('Pr_20_93_47');
    const uri = classificationPset!.properties.find((p) => p.name === 'Uri');
    expect(uri?.value).toBe('https://uniclass.thenbs.com/Pr_20_93_47');
  });
});
