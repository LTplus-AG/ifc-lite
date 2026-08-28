/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Parquet `Type` column must name the class the file actually declares.
 *
 * `IfcTypeEnum` deliberately coalesces several STEP class names onto one
 * value — `IfcDoorStandardCase` onto `IfcDoor`, `IfcSlabStandardCase` onto
 * `IfcSlab`, `IfcDistributionFlowElement` and `IfcDistributionControlElement`
 * onto `IfcDistributionElement` — because the viewer's scope chips group by
 * enum and want one chip per family (`lists/scope-types.test.ts` pins that).
 * `IfcWallStandardCase` survives only because it happens to have been given
 * its own enum value; nothing about it is more exact than the others.
 *
 * Export is not grouping. A `Type` column that answers `IfcDoor` for an
 * `IFCDOORSTANDARDCASE` line is wrong in a way no downstream consumer can
 * undo, and it disagrees with the STEP exporter, which re-emits every class
 * verbatim. So this column reads the exact parsed class via
 * `getExactTypeName`, while `getTypeName` keeps coalescing for its grouping
 * callers.
 *
 * Checked in BOTH directions: every source class must appear, and no source
 * class may be replaced by another. The `COALESCED` list is the anti-vacuity
 * guard — it re-asserts that `getTypeName` still collapses these, so a
 * fixture that stopped exercising the divergence (or an `IfcTypeEnum` that
 * silently widened) fails here instead of passing for the wrong reason.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { ParquetExporter } from './parquet-exporter.js';
import { tableFromIPC } from 'apache-arrow';
import { readParquet } from 'parquet-wasm';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('exact-type.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Aq00000000000000000a',$,'Proj',$,$,$,$,$,$);
#2=IFCDOOR('0Aq00000000000000000b',$,'D1',$,$,$,$,$,$,$);
#3=IFCDOORSTANDARDCASE('0Aq00000000000000000c',$,'D2',$,$,$,$,$,$,$);
#4=IFCWALLSTANDARDCASE('0Aq00000000000000000d',$,'W1',$,$,$,$,$);
#5=IFCWALL('0Aq00000000000000000e',$,'W2',$,$,$,$,$);
#6=IFCDISTRIBUTIONELEMENT('0Aq00000000000000000f',$,'DE',$,$,$,$);
#7=IFCDISTRIBUTIONFLOWELEMENT('0Aq00000000000000000g',$,'DFE',$,$,$,$);
#8=IFCDISTRIBUTIONCONTROLELEMENT('0Aq00000000000000000h',$,'DCE',$,$,$,$,$);
#9=IFCSLABSTANDARDCASE('0Aq00000000000000000i',$,'S1',$,$,$,$,$,$);
#10=IFCSANITARYTERMINAL('0Aq00000000000000000j',$,'ST',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

/**
 * expressId → the class the STEP file declares, named one by one rather than
 * as a count floor: a count says nothing about WHICH class each row got, and
 * the defect this pins swapped classes without changing the row count.
 *
 * `#10` is the negative control. `IfcSanitaryTerminal` is a real IFC4 class
 * with no `IfcTypeEnum` value at all, so it reaches the exact-name path from
 * the other side — proving the change reads the parsed class rather than
 * merely widening the enum lookup.
 */
const EXPECTED_EXACT: ReadonlyArray<readonly [number, string]> = [
  [1, 'IfcProject'],
  [2, 'IfcDoor'],
  [3, 'IfcDoorStandardCase'],
  [4, 'IfcWallStandardCase'],
  [5, 'IfcWall'],
  [6, 'IfcDistributionElement'],
  [7, 'IfcDistributionFlowElement'],
  [8, 'IfcDistributionControlElement'],
  [9, 'IfcSlabStandardCase'],
  [10, 'IfcSanitaryTerminal'],
];

/**
 * The four rows whose enum answer differs from their declared class. If this
 * list ever comes back empty the fixture has stopped reproducing the bug, so
 * assert it is non-empty before trusting anything above it.
 */
const COALESCED: ReadonlyArray<readonly [number, string]> = [
  [3, 'IfcDoor'],
  [7, 'IfcDistributionElement'],
  [8, 'IfcDistributionElement'],
  [9, 'IfcSlab'],
];

async function parse() {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
}

function decode(bytes: Uint8Array): Record<string, unknown>[] {
  return tableFromIPC(readParquet(bytes).intoIPCStream())
    .toArray()
    .map((row) => row.toJSON());
}

describe('Parquet Type column names the declared IFC class', () => {
  it('emits each entity\'s exact class, and never another class in its place', async () => {
    const store = await parse();
    const rows = decode(await new ParquetExporter(store).exportTable('entities'));

    // Anti-vacuity: the fixture must have produced a row per declared entity.
    expect(rows.length).toBe(EXPECTED_EXACT.length);

    const byId = new Map<number, string>(
      rows.map((r) => [Number(r.ExpressId), String(r.Type)]),
    );

    // Forward: every declared class is present, on its own row.
    for (const [id, expected] of EXPECTED_EXACT) {
      expect(byId.get(id), `#${id}`).toBe(expected);
    }

    // Reverse: nothing else leaked into the column. Comparing the whole
    // multiset catches a row that gained a class it should not have, which
    // the per-id loop above cannot see on its own.
    expect([...byId.entries()].sort((a, b) => a[0] - b[0])).toEqual(
      EXPECTED_EXACT.map(([id, t]) => [id, t]),
    );
  });

  it('still coalesces for grouping callers - getTypeName is unchanged', async () => {
    const store = await parse();

    // Anti-vacuity guard for the test above: these rows only prove anything
    // while the enum genuinely disagrees with the declared class.
    expect(COALESCED.length).toBeGreaterThan(0);
    for (const [id, coalescedName] of COALESCED) {
      const exact = EXPECTED_EXACT.find(([e]) => e === id)?.[1];
      expect(exact, `#${id} missing from EXPECTED_EXACT`).toBeDefined();
      expect(store.entities.getTypeName(id), `#${id} getTypeName`).toBe(coalescedName);
      expect(coalescedName, `#${id} must actually diverge`).not.toBe(exact);
    }

    // And the classes that were never coalesced still answer the same way,
    // so the grouping path did not shift underneath the export change.
    expect(store.entities.getTypeName(4)).toBe('IfcWallStandardCase');
    expect(store.entities.getTypeName(10)).toBe('IfcSanitaryTerminal');
  });

  it('degrades to Unknown for an expressId the table does not hold', async () => {
    const store = await parse();
    const entities = store.entities as unknown as {
      getExactTypeName?(id: number): string;
      getTypeName(id: number): string;
    };
    expect(entities.getExactTypeName?.(999_999)).toBe('Unknown');
    expect(entities.getTypeName(999_999)).toBe('Unknown');
  });
});
