/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-element x per-zone table (#2508 item 3).
 *
 * The file's job is to be summed and pivoted by someone who cannot see the
 * model, so the assertions are about the properties that survive that: the
 * rows for one element add up to it, an unmeasurable element is present and
 * says why rather than being dropped, and no value can escape its column.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, toColumns, zoneTableRows, ZONE_TABLE_COLUMNS } from './table.js';
import type { ElementZoneFacts } from './writeback.js';

const ELEMENT = {
  globalId: '0Wall00000000000000042',
  expressId: 42,
  modelName: 'tower.ifc',
  ifcType: 'IfcWall',
  name: 'Basic Wall',
};

/** A straddler split 40/60 across two zones, 5 m3 in total. */
const STRADDLER: ElementZoneFacts = {
  globalId: 42,
  homeZoneName: 'Takt A',
  touchedZoneNames: ['Takt A', 'Takt B'],
  straddles: true,
  shares: [
    { zoneName: 'Takt A', valueM3: 2 },
    { zoneName: 'Takt B', valueM3: 3 },
  ],
  outsideM3: 0,
  refusal: null,
  quantityName: 'NetVolume',
};

describe('zoneTableRows', () => {
  it('emits one row per zone the element reaches', () => {
    const rows = zoneTableRows(ELEMENT, STRADDLER, 'Takt areas', 'net');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.Zone), ['Takt A', 'Takt B']);
    // Long format: the element's identity repeats on every row, which is what
    // lets a pivot group by it.
    assert.ok(rows.every((r) => r.GlobalId === ELEMENT.globalId && r.HomeZone === 'Takt A'));
  });

  it('gives shares that add up to the element, and fractions that add to 1', () => {
    // The invariant #2508 puts above every other for this feature, restated in
    // the shape a spreadsheet will check it in.
    const rows = zoneTableRows(ELEMENT, STRADDLER, 'Takt areas', 'net');
    assert.equal(rows.reduce((sum, r) => sum + (r.VolumeM3 ?? 0), 0), 5);
    assert.equal(rows.reduce((sum, r) => sum + (r.Fraction ?? 0), 0), 1);
    assert.ok(rows.every((r) => r.ElementVolumeM3 === 5));
  });

  it('counts the part outside every zone in the element total, not in a zone', () => {
    // An element hanging off the end of the last takt area: its rows must not
    // sum to its whole volume, or the table would claim the zones contain
    // geometry they do not.
    const rows = zoneTableRows(
      ELEMENT,
      { ...STRADDLER, shares: [{ zoneName: 'Takt A', valueM3: 2 }], touchedZoneNames: ['Takt A'], outsideM3: 3 },
      'Takt areas',
      'net',
    );
    assert.equal(rows[0].VolumeM3, 2);
    assert.equal(rows[0].ElementVolumeM3, 5);
    assert.equal(rows[0].Fraction, 0.4);
  });

  it('keeps an unmeasurable element in the table, with the reason', () => {
    // Dropping it would make the element look absent from a zone the
    // assignment says it is in, and a reader summing the column would get a
    // total that is quietly short.
    const rows = zoneTableRows(
      ELEMENT,
      { ...STRADDLER, shares: [], outsideM3: 0, refusal: 'unproved-solid', quantityName: null },
      'Takt areas',
      'mesh',
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].VolumeM3, null);
    assert.equal(rows[0].Fraction, null);
    assert.match(rows[0].Unavailable, /proven closed solid/);
  });

  it('names the basis on every row, because the number means nothing without it', () => {
    const mesh = zoneTableRows(ELEMENT, STRADDLER, 'Takt areas', 'mesh');
    const net = zoneTableRows(ELEMENT, STRADDLER, 'Takt areas', 'net');
    assert.notEqual(mesh[0].Basis, net[0].Basis);
    assert.equal(net[0].Quantity, 'NetVolume');
  });

  it('does not divide by a zero total', () => {
    const rows = zoneTableRows(
      ELEMENT,
      { ...STRADDLER, shares: [{ zoneName: 'Takt A', valueM3: 0 }], touchedZoneNames: ['Takt A'], outsideM3: 0 },
      'Takt areas',
      'net',
    );
    assert.equal(rows[0].Fraction, null, 'a NaN would reach the spreadsheet');
  });
});

/** Minimal RFC 4180 reader, so the test parses the file the way a spreadsheet
 *  does rather than pattern-matching the text it expected to write. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { fields.push(field); field = ''; }
    else field += c;
  }
  fields.push(field);
  return fields;
}

describe('toCsv', () => {
  it('quotes a value that would otherwise shift every later column', () => {
    // Real IFC names carry commas ("Basic Wall:SW 200,0"), and a shifted row is
    // invisible until someone sums the wrong column.
    const rows = zoneTableRows(
      { ...ELEMENT, name: 'Basic Wall:SW 200,0', ifcType: 'IfcWall' },
      STRADDLER,
      'Takt "A" areas',
      'net',
    );
    const csv = toCsv(rows);
    assert.match(csv, /"Basic Wall:SW 200,0"/);
    // A quote inside a quoted field is doubled, per RFC 4180.
    assert.match(csv, /"Takt ""A"" areas"/);
    // ...and the row parses back to exactly as many fields as the header, which
    // is the property a shifted column breaks.
    const [header, body] = csv.trim().split('\n');
    assert.equal(parseCsvLine(body).length, parseCsvLine(header).length);
    // The name survives the round trip with its comma intact.
    assert.ok(parseCsvLine(body).includes('Basic Wall:SW 200,0'));
  });

  it('writes the header in the declared column order, and ends with a newline', () => {
    const csv = toCsv(zoneTableRows(ELEMENT, STRADDLER, 'Takt areas', 'net'));
    assert.equal(csv.split('\n')[0], ZONE_TABLE_COLUMNS.join(','));
    assert.ok(csv.endsWith('\n'), 'cat of two exports would join two rows');
  });

  it('writes an empty cell for an absent number rather than "null"', () => {
    const rows = zoneTableRows(
      ELEMENT,
      { ...STRADDLER, shares: [], refusal: 'no-geometry', quantityName: null },
      'Takt areas',
      'mesh',
    );
    const body = toCsv(rows).split('\n')[1];
    assert.ok(!body.includes('null'), `null leaked into the CSV: ${body}`);
    assert.ok(body.includes(',,'), 'the empty volume should be an empty cell');
  });
});

describe('toColumns', () => {
  it('produces one array per declared column, all the same length', () => {
    const rows = zoneTableRows(ELEMENT, STRADDLER, 'Takt areas', 'net');
    const columns = toColumns(rows);
    assert.deepEqual(Object.keys(columns), [...ZONE_TABLE_COLUMNS]);
    assert.ok(Object.values(columns).every((c) => c.length === rows.length));
    assert.deepEqual(columns.VolumeM3, [2, 3]);
  });
});
