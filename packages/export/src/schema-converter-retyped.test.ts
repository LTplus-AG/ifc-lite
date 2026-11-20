/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10778: slots IFC4 retyped in place, held to the shared fixture by behaviour
 * through `convertStepLine` (so the test loads with the change reverted).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertStepLine } from './schema-converter.js';
import { Ifc2x3SlotFill } from './schema-converter-ifc2x3-slots.js';

const fixture: { slots: { type: string; index: number; members: string[] }[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_retyped_slots.json', import.meta.url)), 'utf8'),
);

describe('retyped slots (#10778)', () => {
  it('retypes the shared fixture exactly: every member both ways, every other code to $', () => {
    expect(fixture.slots.map(({ type, index }) => [type, index])).toEqual([['IFCMONETARYUNIT', 0]]);
    const members = new Set(fixture.slots[0].members);
    expect(members.size, 'anti-vacuity').toBeGreaterThan(80);
    for (const m of members) {
      for (const to of ['IFC4', 'IFC4X3', 'IFC5'] as const) {
        expect(convertStepLine(`#5=IFCMONETARYUNIT(.${m}.);`, 'IFC2X3', to), `${m} ${to}`).toBe(`#5=IFCMONETARYUNIT('${m}');`);
      }
    }
    // Every three-letter code: a member exactly when the fixture lists it.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of letters) for (const b of letters) for (const c of letters) {
      const code = a + b + c;
      const want = members.has(code) ? `.${code}.` : '$';
      const got = convertStepLine(`#5=IFCMONETARYUNIT('${code}');`, 'IFC4', 'IFC2X3');
      if (got !== `#5=IFCMONETARYUNIT(${want});`) expect(got, code).toBe(`#5=IFCMONETARYUNIT(${want});`);
    }
    // No other record is retyped.
    expect(convertStepLine('#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', 'IFC2X3', 'IFC4')).toBe('#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);');
    expect(convertStepLine("#5=IFCORGANIZATION($,'EUR',$,$,$);", 'IFC4', 'IFC2X3')).toBe("#5=IFCORGANIZATION($,'EUR',$,$,$);");
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

  // Claude review on #10806 (discussion_r4641418586): JS upper-cases the dotless i of `ıNR` to `INR`;
  // Rust folds ASCII only, so the label names no member and is `$` in both twins.
  it('folds case and whitespace ASCII only, so a non-ASCII letter or space invents no currency', () => {
    expect(convertStepLine("#5=IFCMONETARYUNIT('\\X2\\0131\\X0\\NR');", 'IFC4', 'IFC2X3')).toBe('#5=IFCMONETARYUNIT($);');
    expect(convertStepLine("#5=IFCMONETARYUNIT('\\X2\\FEFF\\X0\\INR');", 'IFC4', 'IFC2X3'), 'a byte-order mark').toBe('#5=IFCMONETARYUNIT($);');
    expect(convertStepLine("#5=IFCMONETARYUNIT(' inr ');", 'IFC4', 'IFC2X3'), 'ASCII case and space still fold').toBe('#5=IFCMONETARYUNIT(.INR.);');
    // Raw, not encoded: a byte-order mark and a no-break space in the literal itself.
    const slots = new Ifc2x3SlotFill();
    for (const raw of ['\uFEFFINR', 'INR\u00A0']) expect(convertStepLine(`#5=IFCMONETARYUNIT('${raw}');`, 'IFC4', 'IFC2X3', undefined, slots), JSON.stringify(raw)).toBe('#5=IFCMONETARYUNIT($);');
    expect(slots.warnings()).toContainEqual(expect.stringMatching(/^2 slot\(s\) keep \$ where IFC2X3 requires/));
  });

  it('reads the currency past comments beside it, as Rust does', () => {
    expect(convertStepLine('#5=IFCMONETARYUNIT(/* c */.EUR. /* d */);', 'IFC2X3', 'IFC4')).toBe("#5=IFCMONETARYUNIT('EUR');");
    expect(convertStepLine("#5=IFCMONETARYUNIT(/* c */'EUR'/* d */);", 'IFC4', 'IFC2X3')).toBe('#5=IFCMONETARYUNIT(.EUR.);');
  });

  it('leaves other schema pairs alone', () => {
    expect(convertStepLine("#5=IFCMONETARYUNIT('EUR');", 'IFC4', 'IFC4X3')).toBe("#5=IFCMONETARYUNIT('EUR');");
  });
});
