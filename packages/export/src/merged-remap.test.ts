/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A STEP comment is copied as it is and never opens a string, so the references after it are remapped (#10968). */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter } from './merged-exporter.js';
import { remapEntityText } from './merged-remap.js';

const NO_REMAP = new Map<number, number>();

describe('remapEntityText and STEP comments (#10968)', () => {
  it('remaps the references after a comment that holds an apostrophe', () => {
    expect(remapEntityText("#5=IFCWALL(/* it's */ #3,#4);", 100, NO_REMAP)).toBe("#105=IFCWALL(/* it's */ #103,#104);");
  });

  it('leaves a reference inside a comment as written', () => {
    expect(remapEntityText('#5=IFCWALL(/* was #3 */ #3,$);', 100, NO_REMAP)).toBe('#105=IFCWALL(/* was #3 */ #103,$);');
  });

  it('remaps the references after an unclosed comment opener, as before', () => {
    expect(remapEntityText('#5=IFCWALL(/* note #3,#4);', 100, NO_REMAP)).toBe('#105=IFCWALL(/* note #103,#104);');
  });

  it('points a later model\'s commented reference at its own record in the merged file', async () => {
    const model = (name: string, x: number) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('${name}.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project${name}0000000000000',$,'${name}',$,$,$,$,$,$);
#10=IFCCARTESIANPOINT((${x}.,0.,0.));
#11=IFCAXIS2PLACEMENT3D(/* it's the origin */ #10,$,$);
ENDSEC;
END-ISO-10303-21;
`;
    const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
    const inputs = await Promise.all([{ name: 'a', x: 1 }, { name: 'b', x: 2 }].map(async ({ name, x }) => ({ id: name, name, dataStore: await parse(model(name, x)) })));
    const content = new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema: 'IFC4' })).content);
    const point = new Map([...content.matchAll(/^#(\d+)=IFCCARTESIANPOINT\(\((\d+)\./gm)].map(match => [match[1], match[2]]));
    const placed = [...content.matchAll(/^#\d+=IFCAXIS2PLACEMENT3D\(\/\* it's the origin \*\/ #(\d+),/gm)].map(match => point.get(match[1]));
    expect(placed).toEqual(['1', '2']);
  });

  it('reads a comment opener inside a string as text', () => {
    expect(remapEntityText("#5=IFCWALL('a /* b',#3);", 100, new Map([[3, 7]]))).toBe("#105=IFCWALL('a /* b',#7);");
  });
});
