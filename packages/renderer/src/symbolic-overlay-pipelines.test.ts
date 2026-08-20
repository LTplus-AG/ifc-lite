/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseBoxAlignment } from './symbolic-overlay-pipelines.js';

/**
 * `parseBoxAlignment` decodes IFC `BoxAlignment` (`IfcTextLiteralWithExtent`)
 * into normalized offsets. The type's WHERE rule in the EXPRESS schema
 * (`IFC4_ADD2_TC1.exp`, `IfcBoxAlignment.WR1`) pins the exact string set:
 *
 *   ['top-left', 'top-middle', 'top-right', 'middle-left', 'center',
 *    'middle-right', 'bottom-left', 'bottom-middle', 'bottom-right']
 *
 * Note the asymmetry baked into the spec itself: the row qualifier is
 * top/middle/bottom, the column qualifier is left/middle/right — 'middle'
 * means "vertically centered" as a PREFIX ("middle-left") but "horizontally
 * centered" as a SUFFIX ("top-middle", "bottom-middle"). A parser that
 * checks `includes('middle')` without regard to position cannot tell those
 * apart and misreads half the enum.
 */
describe('parseBoxAlignment: the full IfcBoxAlignment enum (IFC4 WR1)', () => {
  const cases: Array<[string, { horizontal: number; vertical: number }]> = [
    ['top-left',      { horizontal: 0,    vertical: 0 }],
    ['top-middle',    { horizontal: -0.5, vertical: 0 }],
    ['top-right',     { horizontal: -1,   vertical: 0 }],
    ['middle-left',   { horizontal: 0,    vertical: -0.5 }],
    ['center',        { horizontal: -0.5, vertical: -0.5 }],
    ['middle-right',  { horizontal: -1,   vertical: -0.5 }],
    ['bottom-left',   { horizontal: 0,    vertical: -1 }],
    ['bottom-middle', { horizontal: -0.5, vertical: -1 }],
    ['bottom-right',  { horizontal: -1,   vertical: -1 }],
  ];

  for (const [input, expected] of cases) {
    it(`'${input}' -> horizontal=${expected.horizontal}, vertical=${expected.vertical}`, () => {
      assert.deepStrictEqual(parseBoxAlignment(input), expected);
    });
  }

  it('empty string falls back to bottom-left (IFC4 default)', () => {
    assert.deepStrictEqual(parseBoxAlignment(''), { horizontal: 0, vertical: -1 });
  });

  it('is case-insensitive and trims whitespace', () => {
    assert.deepStrictEqual(parseBoxAlignment('  TOP-MIDDLE  '), { horizontal: -0.5, vertical: 0 });
  });
});
