/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * F4 M-export-b (CORE-1, CORE-8): a comment is trivia for the reference
 * collector. Twin of
 * `comments_are_skipped_by_the_reference_scanner` in
 * `rust/export/src/merged/line_edit_tests.rs` (same line, same references).
 */
import { describe, it, expect } from 'vitest';
import { collectRefsInByteRange } from './reference-collector.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('comments are trivia', () => {
  it('collects no reference from a comment and loses none after an apostrophe in one', () => {
    const line = "#5=IFCRELX('g',$,/* it's #99 */$,(#1,#2),#3);";
    expect(collectRefsInByteRange(bytes(line), 0, line.length)).toEqual([5, 1, 2, 3]);
  });

  it('an unterminated comment hides the rest', () => {
    const line = '#5=IFCX(#1,/* open #2';
    expect(collectRefsInByteRange(bytes(line), 0, line.length)).toEqual([5, 1]);
  });
});
