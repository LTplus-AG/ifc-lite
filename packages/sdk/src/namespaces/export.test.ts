/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spreadsheet formula-injection guard (CWE-1236) for `bim.export.csv()`.
 *
 * `docs/guide/extension-authoring.md` points extension authors here as the
 * safe way to build CSV, so the guard has to hold for the values an IFC file
 * can actually carry. Entity names and text properties are author-controlled
 * and survive round-trips, so a malicious or careless model can put anything
 * in a cell.
 *
 * The guard is driven through the public `csv()` rather than the private
 * `escapeCsv`, so these break if the escaping moves or stops being applied to
 * a column.
 */

import { describe, it, expect } from 'vitest';
import { ExportNamespace } from './export.js';
import type { BimBackend } from '../types.js';

/** Backend returning one entity whose Name is whatever the test supplies. */
function backendWithName(name: string): BimBackend {
  return {
    query: {
      entityData: () => ({
        expressId: 1,
        name,
        type: 'IfcWall',
        globalId: 'guid-1',
        description: '',
        objectType: '',
      }),
      properties: () => [],
      quantities: () => [],
    },
    export: { download: () => {} },
  } as unknown as BimBackend;
}

/** The data row of a one-entity, one-column CSV. */
function nameCell(name: string): string {
  const ns = new ExportNamespace(backendWithName(name));
  const csv = ns.csv([{ expressId: 1 } as never], { columns: ['Name'] });
  return csv.split('\n')[1];
}

describe('ExportNamespace.csv formula-injection guard', () => {
  it("prefixes a bare formula trigger so the cell reads as text", () => {
    for (const trigger of ['=', '+', '-', '@']) {
      expect(nameCell(`${trigger}HYPERLINK(http://evil)`)).toMatch(/^'/);
    }
  });

  // The regression. An anchored regex does not match a trigger sitting behind
  // an invisible character, but a spreadsheet still evaluates the cell, so
  // `﻿=HYPERLINK(...)` used to be exported unguarded. Raised on PR #1944.
  it('prefixes a trigger hidden behind an invisible character (#1944)', () => {
    const hidden = [
      ['BOM', '﻿'],
      ['zero-width space', '​'],
      ['left-to-right mark', '‎'],
      ['right-to-left override', '‮'],
      ['non-breaking space', ' '],
    ] as const;

    for (const [label, prefix] of hidden) {
      const cell = nameCell(`${prefix}=HYPERLINK(http://evil)`);
      expect(cell.startsWith("'"), `${label} prefix must still be guarded`).toBe(true);
    }
  });

  // A leading tab or CR is itself a trigger. Matching "invisible characters
  // then a trigger" must not swallow them: treating tab as skippable
  // whitespace would un-guard "\thello", which the guard has always caught.
  it('still guards a leading tab or carriage return on its own', () => {
    expect(nameCell('\thello')).toMatch(/^"?'/);
    expect(nameCell('\rhello')).toMatch(/^"?'/);
  });

  it('leaves ordinary values alone, including invisible characters before text', () => {
    expect(nameCell('Wall-001')).toBe('Wall-001');
    expect(nameCell('﻿Wall-001')).toBe('﻿Wall-001');
    expect(nameCell(' Wall-001')).toBe(' Wall-001');
  });
});
