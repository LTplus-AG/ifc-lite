/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7739: the positional-rename allowance, held to the table the Rust twin also compares. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attrNameTable, convertStepLine } from './schema-converter.js';
import { isStrictAttrPrefix, POSITIONAL_RENAMES } from './schema-converter-renames.js';

interface Row { type: string; pairs: [string, string][] }
const fixture: { renames: Row[] } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_positional_renames.json', import.meta.url)),
    'utf8',
  ),
);

describe('POSITIONAL_RENAMES (#7739)', () => {
  it('is the shared fixture, entry for entry', () => {
    expect(fixture.renames.length).toBeGreaterThanOrEqual(10);
    expect(Object.entries(POSITIONAL_RENAMES).map(([type, pairs]) => ({ type, pairs }))).toEqual(
      fixture.renames.map(({ type, pairs }) => ({ type, pairs })),
    );
  });

  it('lists only same-index renames of the registry', () => {
    const schemas = ['IFC2X3', 'IFC4', 'IFC4X3'] as const;
    for (const [type, pairs] of Object.entries(POSITIONAL_RENAMES)) {
      for (const [older, newer] of pairs) {
        const found = schemas.some((a) =>
          schemas.some((b) => {
            const x = attrNameTable(a)?.get(type);
            const y = attrNameTable(b)?.get(type);
            return !!x && !!y && x.some((name, i) => name === older && y[i] === newer);
          }),
        );
        expect(found, `${type}: ${older} -> ${newer}`).toBe(true);
      }
    }
  });

  it('makes a renamed list a prefix only for a listed type', () => {
    const old = attrNameTable('IFC2X3')!.get('IFCSTAIRFLIGHT')!;
    const next = attrNameTable('IFC4')!.get('IFCSTAIRFLIGHT')!;
    expect(isStrictAttrPrefix(old, next)).toBe(false);
    expect(isStrictAttrPrefix(old, next, 'IFCSTAIRFLIGHT')).toBe(true);
    expect(isStrictAttrPrefix(next, old, 'IFCSTAIRFLIGHT')).toBe(false);
    expect(isStrictAttrPrefix(old, next, 'IFCSTAIR')).toBe(false);
  });

  it('writes IfcStairFlight at the target arity in both directions', () => {
    const up = convertStepLine("#9=IFCSTAIRFLIGHT('g',#2,'n',$,$,#3,#4,$,12,12,0.17,0.28);", 'IFC2X3', 'IFC4');
    expect(up).toBe("#9=IFCSTAIRFLIGHT('g',#2,'n',$,$,#3,#4,$,12,12,0.17,0.28,$);");
    const down = convertStepLine("#9=IFCSTAIRFLIGHT('g',#2,'n',$,$,#3,#4,$,12,12,0.17,0.28,.STRAIGHT.);", 'IFC4', 'IFC2X3');
    expect(down).toBe("#9=IFCSTAIRFLIGHT('g',#2,'n',$,$,#3,#4,$,12,12,0.17,0.28);");
  });
});
