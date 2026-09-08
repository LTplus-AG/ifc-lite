/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { Ifc5Exporter } from './ifc5-exporter.js';

// Regression for the census in PR #3530: an IFCBUILDINGSTOREY with Name = $
// (unnamed) must not have its display placeholder `Entity #<id>` escape into
// the IFC5/IFCX export as a genuinely-declared bsi::ifc::prop::Name.

const UNNAMED_STOREY_IFC4 = `ISO-10303-21;
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
#20=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#21=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#22=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#82=IFCUNITASSIGNMENT((#19,#20,#21));
#83=IFCAXIS2PLACEMENT3D(#3,$,$);
#85=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#83,$);
#90=IFCPROJECT('3k3rYVmQDDW90hT9pdtv9K',#18,'Project',$,$,$,$,(#85),#82);
#92=IFCAXIS2PLACEMENT3D(#3,$,$);
#112=IFCLOCALPLACEMENT($,#92);
#113=IFCSITE('3k3rYVmQDDW90hT9pdtv9M',#18,'TestSite',$,$,#112,$,$,.ELEMENT.,$,$,$,$,$);
#93=IFCLOCALPLACEMENT(#112,#92);
#95=IFCBUILDING('3k3rYVmQDDW90hT9pdtv9L',#18,'TestBuilding',$,$,#93,$,$,.ELEMENT.,$,$,$);
#98=IFCLOCALPLACEMENT(#93,#92);
#99=IFCBUILDINGSTOREY('3k3rYVmQDDW90hT9mO8S_F',#18,$,$,$,#98,$,$,.ELEMENT.,0.);
#363=IFCRELAGGREGATES('2Tp0Y1RCTYVG3kBW3f1hFa',#18,$,$,#90,(#113));
#364=IFCRELAGGREGATES('3QnmEzPqwebvbfIT3RQXck',#18,$,$,#113,(#95));
#365=IFCRELAGGREGATES('3mQBaTfuH9QBHDcYQBQvNl',#18,$,$,#95,(#99));
ENDSEC;
END-ISO-10303-21;`;

describe('fabricated spatial node name escaping into IFC5 export (#3530 census)', () => {
  it('an unnamed IFCBUILDINGSTOREY does not get a fabricated bsi::ifc::prop::Name', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(
      new TextEncoder().encode(UNNAMED_STOREY_IFC4).buffer,
    );

    const exporter = new Ifc5Exporter(store);
    const result = exporter.export({ includeGeometry: false, onlyTreeEntities: false });
    const file = JSON.parse(result.content);

    const storeyNode = file.data.find(
      (n: any) => n.attributes?.['bsi::ifc::class']?.code === 'IfcBuildingStorey',
    );
    expect(storeyNode).toBeTruthy();
    // The unnamed storey's IFC4 Name is `$` (absent). The parser used to
    // fabricate a `Entity #<id>` display placeholder that flowed here
    // unchanged; there must be no bsi::ifc::prop::Name at all now, not even a
    // fabricated one.
    const name = storeyNode.attributes?.['bsi::ifc::prop::Name'];
    if (name !== undefined) expect(name).not.toMatch(/^Entity #\d+$/);
    expect(name).toBeUndefined();
  });

  it('control: a named IFCSITE round-trips its real declared name', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(
      new TextEncoder().encode(UNNAMED_STOREY_IFC4).buffer,
    );

    const exporter = new Ifc5Exporter(store);
    const result = exporter.export({ includeGeometry: false, onlyTreeEntities: false });
    const file = JSON.parse(result.content);

    const siteNode = file.data.find(
      (n: any) => n.attributes?.['bsi::ifc::class']?.code === 'IfcSite',
    );
    expect(siteNode).toBeTruthy();
    expect(siteNode.attributes?.['bsi::ifc::prop::Name']).toBe('TestSite');
  });
});
