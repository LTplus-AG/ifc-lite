/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: `groupRecordReferences` reads the references of an effective export
 * record. A PAGE directive's apostrophe operand (`'Para \S\' 5'`) is string
 * text; closing the literal there made it drop the real references after the
 * string and read `#9` inside the text as one.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupRecordReferences } from './group-graph.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

describe('groupRecordReferences over PAGE-operand literals (#7589)', () => {
  for (const { name, literal } of vectors) {
    it(`${name}: finds the refs after the literal and not the \`#9\` in string text`, () => {
      const record = `#99=IFCGROUP('guid',$,${literal},'see #9',#17,(#11,#12));`;
      expect(groupRecordReferences(record)).toEqual([17, 11, 12]);
    });
  }

  it('still refuses a literal that never closes', () => {
    expect(() => groupRecordReferences("#99=IFCGROUP('guid',$,'Para \\S\\',#17);")).toThrow(/unterminated/);
  });
});
