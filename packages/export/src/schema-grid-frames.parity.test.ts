/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the IfcGridPlacement pin (#9026 item 14). The Rust half is
 * `rust/export/tests/schema_grid_frames_parity.rs`; both run
 * `rust/export/tests/fixtures/schema_grid_placement_vectors.json`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IfcSchemaVersion } from './schema-converter.js';
import { convertStepLine } from './schema-converter.js';
import { StyleFlatten, convertStepLineFlattening } from './schema-style-flatten.js';
import { placeEachObjectOnce } from './schema-ifc2x3-placements.js';

interface Case { why: string; from: IfcSchemaVersion; to: IfcSchemaVersion; records: string[]; expect: string[] }

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_grid_placement_vectors.json', import.meta.url)),
    'utf8',
  ),
);

const G = "#20=IFCGRID('2$abcdefghijklmnopqrst1',$,$,$,$,#10,$,(#1),(#2),$,.NOTDEFINED.);";
const I = '#30=IFCVIRTUALGRIDINTERSECTION((#1,#2),(0.,0.,0.));';

describe('IfcGridPlacement across IFC4X3 matches the shared vectors (#9026 item 14)', () => {
  it('the fixture is not trivial', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    expect(fixture.cases.filter((c) => c.to === 'IFC2X3' && c.records.some((r) => !c.expect.includes(r))).length).toBeGreaterThanOrEqual(8);
  });

  for (const c of fixture.cases) {
    it(`${c.from} -> ${c.to}: ${c.why}`, () => {
      const styles = StyleFlatten.applies(c.from, c.to) ? StyleFlatten.fromRecords(c.records) : undefined;
      const out = c.records.map((r) => convertStepLineFlattening(styles, r, c.from, c.to)).filter((r) => r !== null);
      // Every IFC2X3 output goes through the one-product-per-placement pass (#9209).
      expect(c.to === 'IFC2X3' ? placeEachObjectOnce(out) ?? out : out).toEqual(c.expect);
    });
  }

  it('names no placement of a grid this export leaves out: the frame would dangle', () => {
    const styles = StyleFlatten.fromRecords([G, I]);
    styles.retainGrids((id) => id !== 20);
    expect(styles.apply('#40=IFCGRIDPLACEMENT(#30,$);')).toBe('#40=IFCGRIDPLACEMENT($,#30,$);');
  });

  it('reads an axis the session added to a source grid', () => {
    const line = '#40=IFCGRIDPLACEMENT(#31,$);';
    const axisAdded = "#20=IFCGRID('2$abcdefghijklmnopqrst1',$,$,$,$,#10,$,(#1,#3),(#2),$,.NOTDEFINED.);";
    const store = {
      source: new TextEncoder().encode(G),
      entityIndex: {
        byType: new Map([['IFCGRID', [20]]]),
        byId: new Map([[20, { byteOffset: 0, byteLength: G.length }]]),
      },
    } as unknown as Parameters<typeof StyleFlatten.fromStore>[0];
    const styles = StyleFlatten.fromStore(store, 'IFC4', 'IFC4X3')!;
    styles.noteLine('#31=IFCVIRTUALGRIDINTERSECTION((#3,#2),(0.,0.,0.));');
    expect(styles.apply(line)).toBe('#40=IFCGRIDPLACEMENT($,#31,$);');
    styles.noteEdited(store, (id, _text, type) => (id === 20 && type === 'IFCGRID' ? axisAdded : null));
    expect(styles.apply(line)).toBe('#40=IFCGRIDPLACEMENT(#10,#31,$);');
  });

  it('reshapes the record without the pre-pass as well, so no caller writes the old layout', () => {
    expect(convertStepLine('#40=IFCGRIDPLACEMENT(#30,$);', 'IFC4', 'IFC4X3')).toBe('#40=IFCGRIDPLACEMENT($,#30,$);');
  });
});
