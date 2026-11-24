/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { StepExporter } from './step-exporter.js';

// A source set name is read from the file as raw STEP text and was compared
// with the DECODED name the overlay carries, so a set whose name holds a
// directive (`\X2\…\X0\`), a doubled quote or a doubled backslash never
// matched: editing one of its properties left the source set on the element
// and wrote a second set of the same name beside it.

const wrap = (data: string) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${data}
ENDSEC;
END-ISO-10303-21;`;

const NAMES: Array<[string, string, string]> = [
  ['a non-ASCII letter', 'Pset_Gr\\X2\\00F6\\X0\\\\X2\\00DF\\X0\\e', 'Pset_Größe'],
  ['an apostrophe', "Pset_O''Brien", "Pset_O'Brien"],
  ['a backslash', 'Pset_C:\\\\x', 'Pset_C:\\x'],
  ['a code point beyond the BMP', 'Pset_\\X4\\0001F3E0\\X0\\', 'Pset_🏠'],
];

async function exportEdited(rawSetName: string, decoded: string): Promise<string> {
  const src = wrap([
    `#10=IFCWALL('0wall00000000000000001',$,'W',$,$,$,$,$,$);`,
    `#11=IFCPROPERTYSINGLEVALUE('Keep',$,IFCLABEL('k'),$);`,
    `#12=IFCPROPERTYSINGLEVALUE('Edit',$,IFCLABEL('old'),$);`,
    `#13=IFCPROPERTYSET('0pset00000000000000001',$,'${rawSetName}',$,(#11,#12));`,
    `#14=IFCRELDEFINESBYPROPERTIES('0rel000000000000000001',$,$,$,(#10),#13);`,
    `#20=IFCELEMENTQUANTITY('0qset0000000000000001',$,'${rawSetName}Q',$,$,(#21));`,
    `#21=IFCQUANTITYLENGTH('Len',$,$,1.,$);`,
    `#22=IFCRELDEFINESBYPROPERTIES('0rel000000000000000002',$,$,$,(#10),#20);`,
  ].join('\n'));
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(src).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  view.setProperty(10, decoded, 'Edit', 'new', PropertyValueType.String);
  view.setQuantity(10, `${decoded}Q`, 'Len', 7, QuantityType.Length);
  return new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
}

describe('editing a property of a source set whose name needs STEP escapes', () => {
  for (const [label, raw, decoded] of NAMES) {
    it(`replaces the source set instead of duplicating it (${label})`, async () => {
      const out = await exportEdited(raw, decoded);
      const sets = out.split('\n').filter((l) => /^#\d+=IFCPROPERTYSET\(/.test(l));
      expect(sets).toHaveLength(1);
      expect(out).toContain("IFCLABEL('new')");
      expect(out).not.toContain("IFCLABEL('old')");
      expect(out.split('\n').filter((l) => /^#\d+=IFCELEMENTQUANTITY\(/.test(l))).toHaveLength(1);
    });
  }
});
