/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { EntityNode } from './entity-node.js';

// Regression for the census in PR #3530: an IFCPROPERTYSET with Name = $
// (unnamed) must not have its display placeholder `PropertySet #<id>` escape
// into `EntityNode.properties()` — the query-package surface that MCP tools
// (backend-query.ts `properties()`) and the SDK (`context.ts` `property()`)
// return verbatim as if the model had genuinely declared that name.

const UNNAMED_PSET_IFC4 = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','2023-01-17T16:18:54+01:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCORGANIZATION($,'Org',$,$,$);
#2=IFCAPPLICATION(#1,'1','App','App');
#18=IFCOWNERHISTORY($,#2,$,.NOCHANGE.,$,$,$,0);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#83=IFCAXIS2PLACEMENT3D(#3,$,$);
#85=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#83,$);
#19=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#82=IFCUNITASSIGNMENT((#19));
#90=IFCPROJECT('P',#18,'Project',$,$,$,$,(#85),#82);
#92=IFCAXIS2PLACEMENT3D(#3,$,$);
#112=IFCLOCALPLACEMENT($,#92);
#139=IFCWALL('W',#18,'Wall1',$,$,#112,$,$,.NOTDEFINED.);
#234=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#237=IFCPROPERTYSET('PS',#18,$,$,(#234));
#240=IFCRELDEFINESBYPROPERTIES('RD',#18,$,$,(#139),#237);
#310=IFCQUANTITYLENGTH('Length',$,$,3.5,$);
#311=IFCELEMENTQUANTITY('QS',#18,$,$,$,(#310));
#312=IFCRELDEFINESBYPROPERTIES('RQ',#18,$,$,(#139),#311);
#264=IFCWALL('W2',#18,'Wall2',$,$,#112,$,$,.NOTDEFINED.);
#434=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);
#437=IFCPROPERTYSET('PS2',#18,'Pset_WallCommon',$,(#434));
#440=IFCRELDEFINESBYPROPERTIES('RD2',#18,$,$,(#264),#437);
#510=IFCQUANTITYLENGTH('Width',$,$,0.2,$);
#511=IFCELEMENTQUANTITY('QS2',#18,'Qto_WallBaseQuantities',$,$,(#510));
#512=IFCRELDEFINESBYPROPERTIES('RQ2',#18,$,$,(#264),#511);
ENDSEC;
END-ISO-10303-21;`;

describe('fabricated pset/qset name escaping into query output (#3530 census)', () => {
  it('an unnamed IFCPROPERTYSET does not get a fabricated display name in EntityNode.properties()', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(UNNAMED_PSET_IFC4).buffer);

    const node = new EntityNode(store, 139);
    const psets = node.properties();

    expect(psets.length).toBeGreaterThan(0);
    for (const pset of psets) {
      expect(pset.name).not.toMatch(/^PropertySet #\d+$/);
      expect(pset.name).toBe('');
    }
  });

  it('an unnamed IFCELEMENTQUANTITY does not get a fabricated display name in EntityNode.quantities()', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(UNNAMED_PSET_IFC4).buffer);

    const node = new EntityNode(store, 139);
    const qsets = node.quantities();

    expect(qsets.length).toBeGreaterThan(0);
    for (const qset of qsets) {
      expect(qset.name).not.toMatch(/^QuantitySet #\d+$/);
      expect(qset.name).toBe('');
    }
  });

  it('control: a named IFCPROPERTYSET and IFCELEMENTQUANTITY round-trip their real declared names', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(UNNAMED_PSET_IFC4).buffer);

    const node = new EntityNode(store, 264);
    const psets = node.properties();
    const qsets = node.quantities();

    expect(psets.some((p) => p.name === 'Pset_WallCommon')).toBe(true);
    expect(qsets.some((q) => q.name === 'Qto_WallBaseQuantities')).toBe(true);
  });
});
