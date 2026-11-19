/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10778: slots IFC4 retyped in place, held to the table the Rust twin also compares. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertStepLine } from './schema-converter.js';
import { RETYPED_SLOTS } from './schema-converter-retyped.js';
import { Ifc2x3SlotFill } from './schema-converter-ifc2x3-slots.js';

const fixture: { slots: { type: string; index: number; members: string[] }[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_retyped_slots.json', import.meta.url)), 'utf8'),
);

describe('retyped slots (#10778)', () => {
  it('is the shared fixture, entry for entry', () => {
    expect(RETYPED_SLOTS.map(([type, index, members]) => ({ type, index, members: [...members] })))
      .toEqual(fixture.slots.map(({ type, index, members }) => ({ type, index, members })));
  });

  it('writes a currency member as a label and back', () => {
    expect(convertStepLine('#5=IFCMONETARYUNIT(.EUR.);', 'IFC2X3', 'IFC4')).toBe("#5=IFCMONETARYUNIT('EUR');");
    expect(convertStepLine('#5=IFCMONETARYUNIT(.EUR.);', 'IFC2X3', 'IFC4X3')).toBe("#5=IFCMONETARYUNIT('EUR');");
    expect(convertStepLine("#5=IFCMONETARYUNIT('EUR');", 'IFC4', 'IFC2X3')).toBe('#5=IFCMONETARYUNIT(.EUR.);');
    expect(convertStepLine("#5=IFCMONETARYUNIT('chf');", 'IFC4X3', 'IFC2X3')).toBe('#5=IFCMONETARYUNIT(.CHF.);');
    expect(convertStepLine("#5=IFCMONETARYUNIT(' gbp ');", 'IFC4', 'IFC2X3')).toBe('#5=IFCMONETARYUNIT(.GBP.);');
    expect(convertStepLine("#5=IFCMONETARYUNIT('\\X2\\004500550052\\X0\\');", 'IFC4', 'IFC2X3'), 'an encoded label').toBe('#5=IFCMONETARYUNIT(.EUR.);');
    expect(convertStepLine('#5=IFCMONETARYUNIT(.USD.);', 'IFC2X3', 'IFC5')).toBe("#5=IFCMONETARYUNIT('USD');");
    expect(convertStepLine("#5=IFCMONETARYUNIT('USD');", 'IFC5', 'IFC2X3')).toBe('#5=IFCMONETARYUNIT(.USD.);');
  });

  it('writes $ for a label IFC2X3 has no member for, which the slot fill reports', () => {
    const slots = new Ifc2x3SlotFill();
    expect(convertStepLine("#5=IFCMONETARYUNIT('Bitcoin');", 'IFC4', 'IFC2X3', undefined, slots)).toBe('#5=IFCMONETARYUNIT($);');
    expect(slots.warnings()).toContainEqual(expect.stringMatching(/^1 slot\(s\) keep \$ where IFC2X3 requires/));
  });

  it('reads the currency past comments beside it, as Rust does', () => {
    expect(convertStepLine('#5=IFCMONETARYUNIT(/* c */.EUR. /* d */);', 'IFC2X3', 'IFC4')).toBe("#5=IFCMONETARYUNIT('EUR');");
    expect(convertStepLine("#5=IFCMONETARYUNIT(/* c */'EUR'/* d */);", 'IFC4', 'IFC2X3')).toBe('#5=IFCMONETARYUNIT(.EUR.);');
  });

  it('leaves other schema pairs alone', () => {
    expect(convertStepLine("#5=IFCMONETARYUNIT('EUR');", 'IFC4', 'IFC4X3')).toBe("#5=IFCMONETARYUNIT('EUR');");
  });
});
