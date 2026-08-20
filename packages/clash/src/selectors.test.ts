/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { matchesSelector } from './selectors.js';

describe('matchesSelector', () => {
  it('matches everything with * or empty', () => {
    expect(matchesSelector('IfcWall', '*')).toBe(true);
    expect(matchesSelector('IfcWall', '')).toBe(true);
    expect(matchesSelector('IfcWall', '   ')).toBe(true);
  });

  it('matches exact names case-insensitively', () => {
    expect(matchesSelector('IfcWall', 'IfcWall')).toBe(true);
    expect(matchesSelector('IFCWALL', 'ifcwall')).toBe(true);
    expect(matchesSelector('IfcSlab', 'IfcWall')).toBe(false);
  });

  it('matches wildcard suffixes', () => {
    expect(matchesSelector('IfcPipeSegment', 'IfcPipe*')).toBe(true);
    expect(matchesSelector('IfcPipeFitting', 'IfcPipe*')).toBe(true);
    expect(matchesSelector('IfcDuctSegment', 'IfcPipe*')).toBe(false);
  });

  it('matches pipe-separated alternatives', () => {
    expect(matchesSelector('IfcSlab', 'IfcWall|IfcSlab|IfcRoof')).toBe(true);
    expect(matchesSelector('IfcBeam', 'IfcWall|IfcSlab|IfcRoof')).toBe(false);
    expect(matchesSelector('IfcDuctSegment', 'IfcPipe*|IfcDuct*')).toBe(true);
  });

  it('handles exclusion prefix', () => {
    expect(matchesSelector('IfcWall', '!IfcWall')).toBe(false);
    expect(matchesSelector('IfcSlab', '!IfcWall')).toBe(true);
    expect(matchesSelector('IfcPipeSegment', '!IfcPipe*')).toBe(false);
  });

  it('lets exclusions win inside pipe-alternatives regardless of order', () => {
    expect(matchesSelector('IfcWall', 'Ifc*|!IfcWall')).toBe(false);
    expect(matchesSelector('IfcSlab', 'Ifc*|!IfcWall')).toBe(true);
    expect(matchesSelector('IfcWall', '!IfcWall|Ifc*')).toBe(false);
  });

  it('treats a pure negation list as an AND of exclusions', () => {
    // !A alone: everything except A.
    expect(matchesSelector('IfcWall', '!IfcWall')).toBe(false);
    expect(matchesSelector('IfcSlab', '!IfcWall')).toBe(true);

    // !A|!B: everything except A and except B (not the tautologous
    // literal OR-of-negations reading, which would be true for any
    // single input since nothing is both A and B).
    expect(matchesSelector('IfcWall', '!IfcWall|!IfcSlab')).toBe(false);
    expect(matchesSelector('IfcSlab', '!IfcWall|!IfcSlab')).toBe(false);
    expect(matchesSelector('IfcBeam', '!IfcWall|!IfcSlab')).toBe(true);

    // Mixed positive + negative must be unaffected by the pure-negation
    // handling: exclusions still win regardless of order.
    expect(matchesSelector('IfcWall', 'IfcWall|!IfcSlab')).toBe(true);
    expect(matchesSelector('IfcSlab', 'IfcWall|!IfcSlab')).toBe(false);
    expect(matchesSelector('IfcBeam', 'IfcWall|!IfcSlab')).toBe(false);
  });
});
