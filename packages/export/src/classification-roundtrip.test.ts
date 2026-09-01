/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wall classified via `IfcClassificationReference` /
 * `IfcRelAssociatesClassification` (Uniclass 2015, `Pr_20_93_47`) must
 * survive a STEP → IFCX (IFC5) export: the classification is a real
 * attribute of the source model, not derived geometry, so dropping it is
 * metadata loss (round-trip fidelity oracle, see AGENTS.md classification
 * lens). `Ifc5Exporter.export()` currently walks psets, materials never
 * enter, and the mesh/colour block — but never reads
 * `onDemandClassificationMap` — so every classified entity loses its
 * classification on export, with no warning anywhere in the pipeline.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';

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

describe('IFC5 export carries a source classification through, not just class/props/mesh', () => {
  it('emits the wall\'s Uniclass classification as an ifclite::classifications attribute', async () => {
    const store = await parse(MODEL);
    const exporter = new Ifc5Exporter(store, { meshes: [] } as any);
    const result = exporter.export({ onlyTreeEntities: false, includeGeometry: false });
    const doc = JSON.parse(result.content);

    const wallNode = doc.data.find(
      (n: any) => n.attributes?.['bsi::ifc::prop::Name'] === 'Wall-001',
    );
    expect(wallNode).toBeDefined();

    const classifications = wallNode.attributes?.[IFCLITE_ATTR.CLASSIFICATIONS];
    expect(classifications).toBeDefined();
    expect(classifications).toEqual([
      expect.objectContaining({
        system: 'Uniclass 2015',
        code: 'Pr_20_93_47',
      }),
    ]);
  });
});
