/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { splitStepTopLevel } from './step-top-level-split.js';

describe('splitStepTopLevel (#7785)', () => {
  it('splits at top-level commas only', () => {
    expect(splitStepTopLevel("#1,(#2,#3),'a,b',.T.")).toEqual(['#1', '(#2,#3)', "'a,b'", '.T.']);
  });
  it('a comma, paren or quote inside a comment is not structure', () => {
    expect(splitStepTopLevel("1,/* a, b ) ' */2")).toEqual(['1', '2']);
    expect(splitStepTopLevel('(1,/* , */2),3')).toEqual(['(1,  2)', '3'].map((s) => s.replace('  ', ' ')));
  });
  it('a comment between tokens does not splice them', () => {
    expect(splitStepTopLevel('5/* c */6')).toEqual(['5 6']);
  });
  it('a comment opener inside a string is text', () => {
    expect(splitStepTopLevel("'/* x',2")).toEqual(["'/* x'", '2']);
  });
  it('unterminated comment runs to the end', () => {
    expect(splitStepTopLevel('1,/* 2,3')).toEqual(['1', '']);
  });
  it('PAGE operand apostrophe stays inside the literal', () => {
    expect(splitStepTopLevel("'Para \\S\\' 5',2")).toEqual(["'Para \\S\\' 5'", '2']);
  });
});
