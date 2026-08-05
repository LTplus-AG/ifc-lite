/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { StepTokenizer } from './tokenizer.js';

describe('StepTokenizer.scanEntitiesFast', () => {
  it('finds entities and reports correct expressId/type/line', () => {
    const text = [
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,$,$,$,$,$,$,$);",
    ].join('\n');
    const buffer = new TextEncoder().encode(text);
    const tokenizer = new StepTokenizer(buffer);
    const refs = Array.from(tokenizer.scanEntitiesFast());
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ expressId: 1, type: 'IFCPROJECT', line: 1 });
    expect(refs[1]).toMatchObject({ expressId: 2, type: 'IFCWALL', line: 2 });
  });

  it('does not alias two distinct type names that share a 31-multiplicative hash (type-name cache collision guard)', () => {
    // 'I0OAAA' and 'I10AAA' are two distinct, valid IFC-style type names of
    // the same length that collide under the tokenizer's rolling hash
    // (typeHash = typeLen; typeHash = (typeHash*31+byte)|0 per byte, cache
    // key `${typeLen}:${typeHash}`), found by brute-force search over the
    // exact algorithm. Without the byte-for-byte cache verification in
    // scanEntitiesFast, the second entity's type would be silently misread
    // as the first entity's cached string once the first name populates the
    // cache under the shared key.
    const first = 'I0OAAA';
    const second = 'I10AAA';
    expect(first).toHaveLength(second.length);
    expect(first).not.toBe(second);

    const text = [
      `#1=${first}($);`,
      `#2=${second}($);`,
    ].join('\n');
    const buffer = new TextEncoder().encode(text);
    const tokenizer = new StepTokenizer(buffer);
    const refs = Array.from(tokenizer.scanEntitiesFast());
    expect(refs).toHaveLength(2);
    expect(refs[0].type).toBe(first);
    expect(refs[1].type).toBe(second);
  });
});
