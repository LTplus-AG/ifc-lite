/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `findEntityLength` against the table Rust's `close_step_record` is held to
 * (`close_step_record_finds_the_balancing_paren` and
 * `close_step_record_stops_at_the_next_declaration` in
 * rust/core/src/parser/lexical.rs). Rust is the source of truth for the rule;
 * this pins the TS half to the same answers so the two cannot drift apart
 * one case at a time. The two full scans (tokenizer.test.ts and the worker
 * test) cover what a caller does with the answer.
 */

import { describe, expect, it } from 'vitest';
import { findEntityLength, UNBALANCED_RECORD, UNREADABLE_RECORD } from './step-record-boundary.js';

/** `findEntityLength` over `body`, whose '(' is the first one in it. */
function close(body: string): number {
  const buf = new TextEncoder().encode(body);
  return findEntityLength(buf, buf.indexOf(0x28), 0);
}

describe('findEntityLength', () => {
  it('finds the balancing paren', () => {
    expect(close('IFCWALL($);rest')).toBe(10);
    expect(close('IFCWALL((\'a\'),(1.,2.))\ntail')).toBe(22);
    // A paren inside a literal or a comment is text, and '' stays inside.
    expect(close("IFCWALL('a)b');")).toBe(14);
    expect(close("IFCWALL('a''(b');")).toBe(16);
    expect(close('IFCWALL(/* ) ( */$);')).toBe(19);
  });

  it('classifies the two failures apart', () => {
    expect(close("IFCWALL('never closes")).toBe(UNREADABLE_RECORD);
    expect(close('IFCWALL(/* never closes')).toBe(UNREADABLE_RECORD);
    expect(close('IFCWALL($')).toBe(UNBALANCED_RECORD);
    // A ')' before any '(' closes nothing, but the bytes after are readable.
    expect(findEntityLength(new TextEncoder().encode(')))'), 0, 0)).toBe(UNBALANCED_RECORD);
  });

  /**
   * A ')' after a top-level '=' closes a LATER record's parameter list, so
   * the walk stops at that '=' rather than balancing across a declaration it
   * has not read. Pre-fix `IFCA(2 #2=IFCWALL($));` answered 22 and the
   * scanner resumed past #2 and lost it. The same bound is what keeps a file
   * of unbalanced records linear instead of O(n^2). Regression for #4573.
   */
  it('stops at the next declaration (#4573)', () => {
    expect(close('IFCA(2 #2=IFCWALL($));')).toBe(UNBALANCED_RECORD);
    expect(close('IFCA(2;\n#2=IFCB(3);')).toBe(UNBALANCED_RECORD);
    // An '=' inside a literal or a comment is text, not a declaration, so a
    // record carrying one still closes where it really closes.
    expect(close("IFCA('a=b');")).toBe(11);
    expect(close('IFCA(/* a=b */$);')).toBe(16);
    expect(close("IFCDOCUMENTREFERENCE('http://h/q?a=b&c=d',$);")).toBe(44);
  });
});
