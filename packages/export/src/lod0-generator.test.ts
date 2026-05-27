/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { generateLod0 } from './lod0-generator.js';

const IFC_WITH_BOUNDING_BOX = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');
FILE_NAME('lod0.ifc','2026-05-27T00:00:00',$,$,'ifc-lite','ifc-lite',$);
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Project',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCLOCALPLACEMENT($,#11);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((10.,20.,30.));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));
#31=IFCSHAPEREPRESENTATION($,'Body','BoundingBox',(#32));
#32=IFCBOUNDINGBOX(#20,2.,3.,4.);
#40=IFCWALL('wall-guid',$,'Wall; with semicolon',$,$,#10,#30,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`;

describe('generateLod0', () => {
  it('uses the shared IFC scanner and preserves quoted semicolons in element names', async () => {
    const lod0 = await generateLod0(new TextEncoder().encode(IFC_WITH_BOUNDING_BOX));

    expect(lod0.elements).toHaveLength(1);
    expect(lod0.elements[0]).toMatchObject({
      expressID: 40,
      globalId: 'wall-guid',
      ifcClass: 'IFCWALL',
      name: 'Wall; with semicolon',
      bbox_source: 'shape',
    });
    expect(lod0.elements[0].bbox).toEqual({
      min: [10, 20, 30],
      max: [12, 23, 34],
    });
  });
});
