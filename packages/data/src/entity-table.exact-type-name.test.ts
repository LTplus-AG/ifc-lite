/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getTypeName` resolves through `IfcTypeEnum`, which coalesces class names
 * on purpose so the viewer's scope chips render one chip per family
 * (`lists/scope-types.test.ts`). It only falls back to the parsed name when
 * the enum says `Unknown`, so a known-but-coalesced class never reaches that
 * fallback — which is right for grouping and wrong for export.
 *
 * `getExactTypeName` is the second answer, not a replacement: this file pins
 * BOTH — the exact one for every class the fixture declares, and the
 * coalesced one still coming back unchanged from the same table. It also
 * pins the degradation, because the method is optional and a caller reading
 * it directly instead of through `exactTypeName()` would invent its own.
 */

import { describe, it, expect } from 'vitest';
import { StringTable } from './string-table.js';
import { EntityTableBuilder, entityTableFromColumns, entityTableToColumns } from './entity-table.js';
import { exactTypeName } from './exact-type-name.js';
import { IfcTypeEnum } from './types.js';

/**
 * expressId → [declared STEP class, exact name, coalesced `getTypeName`].
 *
 * Named one by one rather than counted: a count cannot say WHICH class a row
 * received, and the defect this pins swapped classes without changing any
 * count. `IFCSANITARYTERMINAL` is the negative control from the other side —
 * a real IFC4 class with no `IfcTypeEnum` value at all, so both accessors
 * must already agree on it; `IFCWALLSTANDARDCASE` is the control that never
 * lost anything, because it happens to hold its own enum value.
 */
const CASES: ReadonlyArray<readonly [number, string, string, string]> = [
  [1, 'IFCDOOR', 'IfcDoor', 'IfcDoor'],
  [2, 'IFCDOORSTANDARDCASE', 'IfcDoorStandardCase', 'IfcDoor'],
  [3, 'IFCSLABSTANDARDCASE', 'IfcSlabStandardCase', 'IfcSlab'],
  [4, 'IFCDISTRIBUTIONFLOWELEMENT', 'IfcDistributionFlowElement', 'IfcDistributionElement'],
  [5, 'IFCDISTRIBUTIONCONTROLELEMENT', 'IfcDistributionControlElement', 'IfcDistributionElement'],
  [6, 'IFCWALLSTANDARDCASE', 'IfcWallStandardCase', 'IfcWallStandardCase'],
  [7, 'IFCSANITARYTERMINAL', 'IfcSanitaryTerminal', 'IfcSanitaryTerminal'],
];

function build() {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(CASES.length, strings);
  for (const [id, declared] of CASES) builder.add(id, declared, `gid-${id}`, `n-${id}`, '', '');
  return { table: builder.build(), strings };
}

describe('getExactTypeName', () => {
  it('answers the declared class where getTypeName answers the coalesced one', () => {
    const { table } = build();

    // Anti-vacuity: the fixture only proves anything while some rows actually
    // diverge. If IfcTypeEnum ever widened to cover them, this fails first.
    const diverging = CASES.filter(([, , exact, coalesced]) => exact !== coalesced);
    expect(diverging.map(([id]) => id)).toEqual([2, 3, 4, 5]);

    for (const [id, declared, exact, coalesced] of CASES) {
      expect(table.getExactTypeName?.(id), `#${id} ${declared} exact`).toBe(exact);
      expect(table.getTypeName(id), `#${id} ${declared} coalesced`).toBe(coalesced);
      expect(exactTypeName(table, id), `#${id} ${declared} helper`).toBe(exact);
    }
  });

  it('lets a retype override win, exactly as getTypeName does', () => {
    const { table } = build();
    table.setTypeOverride(2, 'IFCCURTAINWALL');
    expect(table.getExactTypeName?.(2)).toBe('IfcCurtainWall');
    expect(table.getTypeName(2)).toBe('IfcCurtainWall');

    table.setTypeOverride(2, null);
    expect(table.getExactTypeName?.(2)).toBe('IfcDoorStandardCase');
  });

  it('degrades to Unknown for an expressId the table does not hold', () => {
    const { table } = build();
    expect(table.getExactTypeName?.(999_999)).toBe('Unknown');
    expect(exactTypeName(table, 999_999)).toBe('Unknown');
  });

  it('falls back to the enum name when the table shape tracked no parsed names', () => {
    // Server hydration and legacy cache reads hand `entityTableFromColumns`
    // no `rawTypeName` column at all; it zero-fills, and string index 0 is
    // ''. Such a table knows nothing more exact than its enum, and must say
    // so rather than returning the empty string.
    const { table, strings } = build();
    const columns = entityTableToColumns(table);
    delete columns.rawTypeName;
    const legacy = entityTableFromColumns(columns, strings);

    expect(legacy.getExactTypeName?.(2)).toBe('IfcDoor');
    expect(exactTypeName(legacy, 2)).toBe('IfcDoor');
    // Genuinely outside the enum AND with no parsed name to fall back on:
    // 'Unknown' is the only honest answer, and it must not be ''.
    expect(legacy.getTypeEnum(7)).toBe(IfcTypeEnum.Unknown);
    expect(legacy.getExactTypeName?.(7)).toBe('Unknown');
  });

  it('falls back to getTypeName on a table shape that implements no exact accessor', () => {
    // `getExactTypeName` is optional, so `apps/viewer`'s server-data literal
    // and `@ifc-lite/cache`'s reader stay valid `EntityTable`s without it.
    // The helper is the ONE place that degradation lives.
    const { table } = build();
    const withoutAccessor = { ...table, getExactTypeName: undefined };
    expect(exactTypeName(withoutAccessor, 2)).toBe('IfcDoor');
    expect(exactTypeName(withoutAccessor, 3)).toBe('IfcSlab');
  });
});
