/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: the cost-removal reference guard walks record text for `#N`. A PAGE
 * directive's apostrophe operand (`'Para \S\' 5'`) is string text; ending the
 * literal there flipped the walk's string state for the rest of the record, so
 * the real reference after it was missed (a cost value deleted while still
 * referenced) and `#9` inside the text was counted.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveCostReferenceOccurrences } from './cost-reference-scan.js';

const LINES = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('cost.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#5=IFCCOSTVALUE('Five',$,$,$,$,$,$);",
  "#9=IFCCOSTVALUE('Nine',$,$,$,$,$,$);",
  // The Description holds a PAGE operand; `#9` is only text; `#5` is real.
  "#20=IFCWALL('0wall00000000000000001',$,'Wall','Art \\S\\' #9',#5,$,$,$,$);",
  'ENDSEC;',
  'END-ISO-10303-21;',
];

describe('effectiveCostReferenceOccurrences over PAGE-operand literals (#7589)', () => {
  it('counts the real reference after the literal and not the `#9` inside it', async () => {
    const bytes = new TextEncoder().encode(LINES.join('\n'));
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const view = new MutablePropertyView(null, 'm');
    const found = effectiveCostReferenceOccurrences(store, view, new Set([5, 9]));
    expect([...found.keys()]).toEqual([5]);
    expect(found.get(5)).toEqual(new Map([[20, 1]]));
  });
});
