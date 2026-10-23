/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseStep } from './extract-entities.js';
import { productsUnderPlacement } from './storey-selection.js';

/** A storey placement #1000, `depth` nested placements below it, and a wall on the deepest. */
function nested(depth: number, cycle = false): string {
  const lines = ['#1000=IFCLOCALPLACEMENT($,#1);', '#1=IFCAXIS2PLACEMENT3D(#2,$,$);', '#2=IFCCARTESIANPOINT((0.,0.,0.));'];
  for (let i = 1; i <= depth; i++) lines.push(`#${1000 + i}=IFCLOCALPLACEMENT(#${1000 + i - 1},#1);`);
  if (cycle) lines[0] = `#1000=IFCLOCALPLACEMENT(#${1000 + depth},#1);`;
  lines.push(`#9000=IFCWALL('0000000000000000000000',$,'w',$,$,#${1000 + depth},$,$,$);`);
  return `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

describe('productsUnderPlacement (#7791, D27: no depth guard)', () => {
  it('finds a product nested 300 placements below the storey (the old guard stopped at 128)', () => {
    expect(productsUnderPlacement(1000, parseStep(nested(300))).has(9000)).toBe(true);
  });

  it('does not select a product whose chain cycles without reaching the storey', () => {
    // #1001 points past the storey to #1003, so #1001..#1003 form a cycle that
    // never reaches #1000.
    const text = nested(3).replace('#1001=IFCLOCALPLACEMENT(#1000,#1);', '#1001=IFCLOCALPLACEMENT(#1003,#1);');
    expect(productsUnderPlacement(1000, parseStep(text)).has(9000)).toBe(false);
  });
});
