/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Catastrophic-backtracking regression test for `STEP_TRIVIA` (#3796 review
 * follow-up). The comment alternative in the original `#3789` pattern used a
 * lazy `[\s\S]*?` body inside `(?:A|B)*`: when the *overall* pattern fails
 * past a comment, the engine retries that lazy body against every later
 * `*​/` in the string, so one comment can absorb subsequent ones and the
 * two alternatives overlap on the same span — the classic `(?:A|B)*`
 * ambiguity, exponential in the number of comments.
 *
 * ~120 bytes of legal, properly paired `/**​/` comments (n=30, no
 * malformed syntax) took multiple seconds to multiple minutes depending on
 * hardware before the fix, and was still climbing (n=30 measured >15s on
 * one machine, unresponsive past that). The bound below (1s) sits between
 * the fixed-pattern time (sub-millisecond, linear) and the broken-pattern
 * time at this n (multiple seconds and climbing per additional comment) —
 * wide enough to never flake on a loaded machine, tight enough that no
 * linear-time regex could plausibly need it for 120 bytes of input.
 */

import { describe, expect, it } from 'vitest';
import { EntityExtractor } from '../src/entity-extractor.js';
import type { EntityRef } from '../src/types.js';

const TIMEOUT_BOUND_MS = 1000;

function extract(record: string) {
  const buffer = new TextEncoder().encode(record);
  const ref: EntityRef = { expressId: 5, type: 'IFCWALL', byteOffset: 0, byteLength: buffer.length, lineNumber: 1 };
  return new EntityExtractor(buffer).extractEntity(ref);
}

describe('STEP_TRIVIA: linear-time on a run of well-formed comments (ReDoS regression)', () => {
  it('matches (or fails) a record trailed by 30 well-formed empty comments in well under a second', () => {
    // Deliberately missing the closing "(...)" so the enclosing regex is
    // FORCED to backtrack through the whole trivia run looking for a way to
    // satisfy the rest of the pattern -- exactly the failure path that
    // exercises the ambiguity. Only well-formed, properly paired comments;
    // no malformed syntax anywhere in the input.
    const record = '#5=IFCWALL' + '/**/'.repeat(30);

    const start = Date.now();
    const entity = extract(record);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(TIMEOUT_BOUND_MS);
    // No closing "(...)" -- this is not a valid entity record, so it must
    // fail to extract, not merely "finish quickly".
    expect(entity).toBeNull();
  });

  it('still matches a well-formed record with the same run of comments before "(" (semantics preserved)', () => {
    const record = '#5=IFCWALL' + '/**/'.repeat(30) + '(#4,0.);';

    const start = Date.now();
    const entity = extract(record);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(TIMEOUT_BOUND_MS);
    expect(entity).not.toBeNull();
    expect(entity!.attributes.length).toBe(2);
  });
});
