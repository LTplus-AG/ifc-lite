/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Catastrophic-backtracking regression test for `STEP_TRIVIA`, one case per
 * axis. `STEP_TRIVIA` is `(?:whitespace|comment)*`, and that shape blows up
 * whenever either alternative gives the outer `*` more than one way to
 * partition the same span. Both alternatives have gone wrong that way once,
 * so both are pinned here.
 *
 * COMMENT axis: a lazy `[\s\S]*?` comment body. When the overall pattern
 * fails past a comment, the engine retries the lazy body against every later
 * `*​/`, so one comment absorbs the ones after it and the two alternatives
 * overlap. Measured with that body: 30 well-formed `/**​/` comments (~120
 * bytes) took seconds to minutes depending on hardware.
 *
 * WHITESPACE axis: a `[ \t\n\r\x0b\x0c]+` alternative. `+` looks like it
 * collapses a run into one iteration, but the outer `*` can still split an
 * n-character run into any composition of `+` matches — the textbook
 * `(?:A+|B)*` blowup, and on the far more common input (plain whitespace is
 * exactly what #3789 is about). Measured with `+`: 26 spaces 510ms, 28
 * spaces 1.9s, 1000 spaces did not finish in two minutes. Without `+`, one
 * MILLION spaces matches in ~4ms.
 *
 * The 1s bound sits between the fixed times (sub-millisecond, linear on both
 * axes) and the broken times at these n (seconds, and doubling per extra
 * character) — wide enough not to flake on a loaded machine, tight enough
 * that no linear-time regex could plausibly need it for ~120 bytes.
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

function timed(record: string) {
  const start = Date.now();
  const entity = extract(record);
  return { entity, elapsed: Date.now() - start };
}

describe('STEP_TRIVIA: linear-time on a run of legal trivia (ReDoS regression)', () => {
  it('comment axis: 30 well-formed comments and no closing "(...)" fails fast', () => {
    // Deliberately missing the closing "(...)" so the enclosing regex is
    // FORCED to backtrack through the whole trivia run looking for a way to
    // satisfy the rest of the pattern -- exactly the failure path that
    // exercises the ambiguity. Only well-formed, properly paired comments;
    // no malformed syntax anywhere in the input.
    const { entity, elapsed } = timed('#5=IFCWALL' + '/**/'.repeat(30));

    expect(elapsed).toBeLessThan(TIMEOUT_BOUND_MS);
    // No closing "(...)" -- this is not a valid entity record, so it must
    // fail to extract, not merely "finish quickly".
    expect(entity).toBeNull();
  });

  it('whitespace axis: 30 spaces and no closing "(...)" fails fast', () => {
    const { entity, elapsed } = timed('#5=IFCWALL' + ' '.repeat(30));

    expect(elapsed).toBeLessThan(TIMEOUT_BOUND_MS);
    expect(entity).toBeNull();
  });

  it('whitespace axis: a wrap that ends in a non-trivia byte fails fast', () => {
    // The realistic shape: a wrapped record whose enclosing regex ultimately
    // fails on something OTHER than the whitespace -- here U+00A0, which is
    // deliberately not STEP whitespace (#3733). Kept at the same n as the
    // case above so a regression FAILS in bounded time (seconds) rather than
    // hanging the CI job: the blowup doubles per extra character, so a long
    // run would never return at all.
    const { entity, elapsed } = timed('#5=IFCWALL' + ' '.repeat(30) + '\u00a0(#4,0.);');

    expect(elapsed).toBeLessThan(TIMEOUT_BOUND_MS);
    expect(entity).toBeNull();
  });

  it('still matches a well-formed record with a long run of trivia before "(" (semantics preserved)', () => {
    const { entity, elapsed } = timed('#5=IFCWALL' + ' /**/\t'.repeat(30) + '(#4,0.);');

    expect(elapsed).toBeLessThan(TIMEOUT_BOUND_MS);
    expect(entity).not.toBeNull();
    expect(entity!.attributes.length).toBe(2);
  });
});
