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

// Same two owner histories, but the wall carries NEITHER (`$`), so a generated
// pset has to go through the FALLBACK path — the first owner history that
// survives this export — rather than inheriting one from its host.
const IFC_FALLBACK_OH = `ISO-10303-21;
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
#10=IFCWALL('0wall10000000000000000',$,'W',$,$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
ENDSEC;
END-ISO-10303-21;`;

describe('StepExporter — the owner-history caches are per export, not per exporter', () => {
  /**
   * `export()` clears `ownerHistory.fallbackRef` and `ownerHistory.byEntity` on
   * entry, because both depend on `willBeEmitted` and therefore on THIS call's
   * options and on whatever the shared `MutablePropertyView` has since deleted.
   *
   * That guard is ALREADY pinned, by `overlay-effective-model.test.ts`'s "does
   * not answer a second export from the first one's owner-history cache" — a
   * mutation neutralising the two reset statements kills that test too, not
   * only this one. This is a second angle on it rather than a new pin, and the
   * distinction is worth stating so nobody reads this file as the safety net.
   *
   * What this adds is the OTHER route to the cache and a stronger assertion.
   * The existing test reaches the stale cache through overlay deletion and
   * checks a count; here the host element carries `$` for its own owner
   * history, so the generated pset must go through the fallback SCAN — "first
   * owner history that survives this export" — and the check is structural:
   * `danglingRefs` must stay empty. A stale fallback stamps an id whose line
   * the second export no longer contains, which is invalid STEP rather than
   * merely a wrong count.
   *
   * Note what does NOT reach this: `visibleOnly`, which the reset's own comment
   * offers as its example. `IFCOWNERHISTORY` is in `reference-collector.ts`'s
   * `INFRASTRUCTURE_TYPES` (:54), so hiding entities does not change whether an
   * owner history is emitted. Deletion through the mutation view is the lever
   * both tests actually use.
   */
  it('re-derives the fallback owner history after the first choice is deleted', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC_FALLBACK_OH).buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm');
    view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
    view.setProperty(10, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const exporter = new StepExporter(store, view);

    const out1 = decode(exporter.export({ schema: 'IFC4', applyMutations: true }).content);
    // #5 is the first surviving owner history, so the fallback picks it.
    expect(out1).toMatch(/=IFCPROPERTYSET\('.{22}',#5,'Pset_WallCommon'/);
    expect(danglingRefs(out1)).toEqual([]);

    // The caller keeps editing the same view between exports.
    view.deleteEntity(5);

    const out2 = decode(exporter.export({ schema: 'IFC4', applyMutations: true }).content);
    // Must re-scan and land on #6. Without the reset this still says #5, whose
    // line the second export no longer contains.
    expect(out2).toMatch(/=IFCPROPERTYSET\('.{22}',#6,'Pset_WallCommon'/);
    expect(out2).not.toMatch(/=IFCPROPERTYSET\('.{22}',#5,/);
    expect(danglingRefs(out2)).toEqual([]);
  });
});
