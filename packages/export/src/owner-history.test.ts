/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { StepExporter } from './step-exporter.js';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// Minimal IFC2X3 model: a wall with Pset_WallCommon, all roots carrying the
// shared owner history #5 (mandatory in IFC2X3).
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPERSON($,'','U',$,$,$,$,$);
#2=IFCORGANIZATION($,'Org',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','app','app');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#10=IFCWALL('0wall00000000000000000',#5,'W',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
#30=IFCPROPERTYSET('0pset00000000000000000',#5,'Pset_WallCommon',$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('0rel000000000000000000',#5,$,$,(#10),#30);
ENDSEC;
END-ISO-10303-21;`;

describe('StepExporter — generated psets carry OwnerHistory (IFC2X3)', () => {
  it('stamps generated IfcPropertySet/IfcRelDefinesByProperties with an existing owner history', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm');
    view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
    view.setProperty(10, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const out = decode(new StepExporter(store, view).export({ schema: 'IFC2X3', applyMutations: true }).content);

    // The regenerated pset + rel must reference the model's owner history (#5),
    // not `$` — OwnerHistory is mandatory in IFC2X3.
    expect(out).toMatch(/=IFCPROPERTYSET\('.{22}',#5,'Pset_WallCommon'/);
    expect(out).toMatch(/=IFCRELDEFINESBYPROPERTIES\('.{22}',#5,/);
    // No generated pset/rel left an empty ($) owner history.
    expect(out).not.toMatch(/=IFCPROPERTYSET\('.{22}',\$,/);
    expect(out).not.toMatch(/=IFCRELDEFINESBYPROPERTIES\('.{22}',\$,/);
  });
});
