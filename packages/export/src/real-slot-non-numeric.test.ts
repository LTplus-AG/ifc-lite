/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A non-numeric value in a REAL-typed named attribute (#2741).
 *
 * #2725 keyed REAL formatting off schema type, which fixed the common case: a
 * numeric string now writes an unquoted REAL. A NON-numeric value still fell
 * through and was QUOTED, producing the same ISO 10303-21 violation that fix
 * exists to prevent.
 *
 * Every test here asserts BOTH halves: the bad output is absent AND the drop is
 * reported. Asserting only the absence would pass just as well if the edit
 * vanished without trace, which is the failure #2723/#2724/#2726 were written
 * to pin - an exporter claiming a modification it did not carry.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const MAP_ID = 41;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#40=IFCPROJECTEDCRS('EPSG:1000',$,$,$,$,$,$);
#41=IFCMAPCONVERSION($,#40,1000.,2000.,0.,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

async function exportWithScale(value: string) {
  const store = await parseBase();
  const view = new MutablePropertyView(null, 'test-model');
  new StoreEditor(store, view).setAttribute(MAP_ID, 'Scale', value);
  const result = new StepExporter(store, view).export({ schema: 'IFC4' });
  const text = new TextDecoder().decode(result.content);
  const line = text.split('\n').find((l) => l.startsWith(`#${MAP_ID}=`)) ?? '';
  return { line, warnings: result.stats.warnings.join('\n') };
}

describe('a non-numeric REAL-typed attribute edit', () => {
  it('is not written as a quoted string, and says so', async () => {
    const { line, warnings } = await exportWithScale('abc');
    // The violation: a quoted string where the schema declares a REAL.
    expect(line, 'a non-numeric value was written into a REAL slot').not.toContain("'abc'");
    // The slot keeps what the file had.
    expect(line).toContain('#41=IFCMAPCONVERSION($,#40,1000.,2000.,0.,$,$,$);');
    // ...and the drop is visible, not inferred from absence.
    expect(warnings).toContain('#41');
    expect(warnings).toContain('Scale');
    expect(warnings).toMatch(/not a number/);
  });

  it('rejects a stringified NaN, which Number() would otherwise accept as a value', async () => {
    // `Number('NaN')` is NaN, not a parse failure, so a naive isNaN-free guard
    // would emit the token `NaN` - lexically invalid STEP that re-parses as a
    // different argument count and shifts every slot after it.
    const { line, warnings } = await exportWithScale(String(Number.NaN));
    expect(line).not.toContain("'NaN'");
    expect(line).not.toMatch(/,NaN[,)]/);
    expect(warnings).toContain('#41');
  });

  it('rejects Infinity for the same reason', async () => {
    const { line, warnings } = await exportWithScale('Infinity');
    expect(line).not.toContain("'Infinity'");
    expect(line).not.toMatch(/,Infinity[,)]/);
    expect(warnings).toContain('#41');
  });

  it('still writes a numeric value, and warns about nothing', async () => {
    // The #2725 behaviour must be untouched: this is the case that works.
    const { line, warnings } = await exportWithScale('2.5');
    expect(line).toMatch(/,2\.5[,)]/);
    expect(line).not.toContain("'2.5'");
    expect(warnings).not.toContain('Scale');
  });

  it('still clears the slot for an empty value, and warns about nothing', async () => {
    const { line, warnings } = await exportWithScale('');
    expect(line).toContain('#41=IFCMAPCONVERSION($,#40,1000.,2000.,0.,$,$,$);');
    expect(warnings).not.toContain('Scale');
  });
});
