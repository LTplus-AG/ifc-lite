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

// A wall with two property sets that SHARE one IfcPropertySingleValue (#20),
// mirroring how IFC exporters deduplicate Pset_*Common atoms (e.g. IsExternal).
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0wall00000000000000000',$,'W',$,$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('Shared',$,IFCLABEL('orig'),$);
#21=IFCPROPERTYSINGLEVALUE('OnlyA',$,IFCLABEL('a'),$);
#22=IFCPROPERTYSINGLEVALUE('OnlyB',$,IFCLABEL('b'),$);
#30=IFCPROPERTYSET('0psetA0000000000000000',$,'Pset_A',$,(#20,#21));
#31=IFCPROPERTYSET('0psetB0000000000000000',$,'Pset_B',$,(#20,#22));
#40=IFCRELDEFINESBYPROPERTIES('0relA00000000000000000',$,$,$,(#10),#30);
#41=IFCRELDEFINESBYPROPERTIES('0relB00000000000000000',$,$,$,(#10),#31);
ENDSEC;
END-ISO-10303-21;`;

describe('StepExporter — shared property atoms (issue #1413)', () => {
  it('keeps a shared atom when only one of its psets is edited', async () => {
    const parser = new IfcParser();
    const store = await parser.parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });

    const view = new MutablePropertyView(null, 'm');
    view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
    // Edit a property in Pset_A only; #20 is shared with Pset_B.
    view.setProperty(10, 'Pset_A', 'OnlyA', 'edited', PropertyValueType.Label);

    const out = decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);

    // No dangling refs — the shared atom #20 is retained for Pset_B.
    expect(danglingRefs(out)).toEqual([]);
    expect(out).toMatch(/(^|\n)\s*#20\s*=/);
    // Pset_B is untouched and still references the original shared value.
    expect(out).toContain("IFCLABEL('orig')");
    // The edit is applied (new value present).
    expect(out).toContain('edited');
  });
});
