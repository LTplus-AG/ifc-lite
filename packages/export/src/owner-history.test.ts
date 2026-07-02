/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { StepExporter } from './step-exporter.js';

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Referenced `#N` tokens that have no `#N=` definition. */
function danglingRefs(text: string): number[] {
  const defined = new Set<number>();
  for (const m of text.matchAll(/(^|\n)\s*#(\d+)\s*=/g)) defined.add(+m[2]);
  const refs = new Set<number>();
  for (const m of text.matchAll(/#(\d+)/g)) refs.add(+m[1]);
  return [...refs].filter(id => !defined.has(id)).sort((a, b) => a - b);
}

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

// Two owner histories — #5 (first in the file) and #6 — modelling a federated /
// merged export. The edited wall #10 carries the SECOND one (#6). A generated
// pset must inherit the host element's OWN owner history (#6), not the file's
// first owner history (#5); stamping #5 mis-attributes the pset to the wrong
// source model. Both owner histories are emitted (IfcOwnerHistory is always kept
// as infrastructure), so this is an attribution check, not a dangling-ref one.
const IFC_MULTI_OH = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'Org',$,$,$);
#3=IFCPERSONANDORGANIZATION($,#2,$);
#4=IFCAPPLICATION(#2,'1','app','app');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCOWNERHISTORY(#3,#4,$,.MODIFIED.,$,$,$,1);
#10=IFCWALL('0wall10000000000000000',#6,'W',$,$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
#30=IFCPROPERTYSET('0psetB0000000000000000',#6,'Pset_WallCommon',$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('0relB00000000000000000',#6,$,$,(#10),#30);
ENDSEC;
END-ISO-10303-21;`;

describe('StepExporter — generated psets inherit the host element owner history', () => {
  it('stamps the edited element own owner history, not the file first one', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC_MULTI_OH).buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm');
    view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
    view.setProperty(10, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const out = decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);

    // Wall #10 owns owner history #6 — the regenerated pset + rel must carry it,
    // not the file's first owner history #5.
    expect(out).toMatch(/=IFCPROPERTYSET\('.{22}',#6,'Pset_WallCommon'/);
    expect(out).toMatch(/=IFCRELDEFINESBYPROPERTIES\('.{22}',#6,/);
    expect(out).not.toMatch(/=IFCPROPERTYSET\('.{22}',#5,/);
    expect(danglingRefs(out)).toEqual([]);
  });
});
