/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcTypeEnum` covers ~1/8 of the IFC schema, so the string -> enum table
 * behind `IfcTypeEnumFromString` deliberately coalesces some classes onto a
 * coarser one: `IFCDOORSTANDARDCASE` resolves to `IfcDoor`, and the round
 * trip through `IfcTypeEnumToString` reports "IfcDoor" for it. That is
 * lossy but SOUND — a door standard case IS a door.
 *
 * It stops being sound the moment the coarser class is not an ancestor. The
 * table had three such rows, each pointing at a SIBLING or a CHILD:
 *
 *   IfcTendonAnchor        -> IfcTendon              (both IfcReinforcingElement)
 *   IfcFastener            -> IfcMechanicalFastener  (the CHILD of the key)
 *   IfcCableCarrierSegment -> IfcCableSegment        (both IfcFlowSegment)
 *
 * so `getTypeName` renamed those elements to a different IFC class, and the
 * Parquet exporter's Type column (parquet-exporter.ts, "The unretyped name
 * comes from `entities.getTypeName(id)`") wrote that wrong class to file.
 *
 * The rule is checked against the bundled schema registries rather than a
 * list of the three, so a future row is held to it too.
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum, IfcTypeEnumFromString, IfcTypeEnumToString } from './types.js';
import { ENTITIES_IFC2X3 } from './ifc-schema/generated/entities-ifc2x3.js';
import { ENTITIES_IFC4 } from './ifc-schema/generated/entities-ifc4.js';
import { ENTITIES_IFC4X3 } from './ifc-schema/generated/entities-ifc4x3.js';

/** name -> parent, unioned over every schema version the package bundles. */
const PARENT = new Map<string, string | undefined>();
for (const registry of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
  for (const e of registry) {
    // A later registry's parent wins only when the earlier one had none, so a
    // class re-parented across versions keeps a real edge either way.
    if (PARENT.get(e.name) === undefined) PARENT.set(e.name, e.parent);
  }
}

/** `[name, ...ancestors]`, cycle-guarded. */
function chain(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = name;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = PARENT.get(cur);
  }
  return out;
}

/** Every class the table can resolve, paired with what it resolves to. */
const RESOLVED = [...PARENT.keys()]
  .map((name) => ({ name, enumValue: IfcTypeEnumFromString(name) }))
  .filter((r) => r.enumValue !== IfcTypeEnum.Unknown)
  .map((r) => ({ ...r, resolvesTo: IfcTypeEnumToString(r.enumValue) }));

describe('IfcTypeEnumFromString never resolves a class to a non-ancestor', () => {
  it('has a table and a schema big enough for the sweep to mean anything', () => {
    // Anti-vacuity on both parse counts: a registry regex that stopped
    // matching, or a table that stopped resolving, would otherwise make every
    // assertion below pass over an empty set.
    expect(PARENT.size).toBeGreaterThan(700);
    expect(RESOLVED.length).toBeGreaterThan(100);
    // The three classes the rule was written for must be in the schema the
    // sweep walks — otherwise the sweep could never have seen them, and the
    // rows could come back unnoticed under a different spelling.
    for (const required of ['IfcTendonAnchor', 'IfcFastener', 'IfcCableCarrierSegment']) {
      expect([required, PARENT.has(required)]).toEqual([required, true]);
    }

    // And the sweep must still resolve real coalescing rows, so "no
    // violations" cannot be reached by the table resolving nothing.
    const swept = new Set(RESOLVED.map((r) => r.name));
    for (const required of ['IfcDoorStandardCase', 'IfcDistributionFlowElement', 'IfcWall', 'IfcSpace']) {
      expect([required, swept.has(required)]).toEqual([required, true]);
    }
  });

  it('resolves every schema class to itself or to one of its ancestors', () => {
    const violations = RESOLVED.filter((r) => !chain(r.name).includes(r.resolvesTo)).map(
      (r) => `${r.name} -> ${r.resolvesTo} (ancestry: ${chain(r.name).join(' <- ')})`,
    );

    expect(violations).toEqual([]);
  });

  it('names the three classes the rule was written for, in both directions', () => {
    // Forward: each is asserted POSITIVELY, against the one value the table
    // may hold for it, rather than negatively against the single wrong value
    // it used to hold. A `.not.toBe('IfcCableSegment')` row passes for every
    // value except that one, so re-pointing IfcCableCarrierSegment at
    // IfcFlowSegment would satisfy it — and the ancestry sweep above cannot
    // catch that either, because IfcFlowSegment IS an ancestor of
    // IfcCableCarrierSegment. The raw class name would be replaced by a
    // coarser one again, which is the defect this file exists to pin.
    //
    // The enum has no member for any of the three, so `Unknown` is the only
    // sound answer: it is the miss sentinel that sends `getTypeName` to the
    // rawTypeName column, where the parsed class name is.
    expect(IfcTypeEnumFromString('IfcTendonAnchor')).toBe(IfcTypeEnum.Unknown);
    expect(IfcTypeEnumFromString('IfcFastener')).toBe(IfcTypeEnum.Unknown);
    expect(IfcTypeEnumFromString('IfcCableCarrierSegment')).toBe(IfcTypeEnum.Unknown);

    // Backward: the classes they were folded into still resolve to themselves.
    // Without this, deleting the enum members entirely would pass the row above.
    expect(IfcTypeEnumToString(IfcTypeEnumFromString('IfcTendon'))).toBe('IfcTendon');
    expect(IfcTypeEnumToString(IfcTypeEnumFromString('IfcMechanicalFastener'))).toBe('IfcMechanicalFastener');
    expect(IfcTypeEnumToString(IfcTypeEnumFromString('IfcCableSegment'))).toBe('IfcCableSegment');
  });

  it('still accepts the sound coalescing rows, and rejects a fabricated unsound one', () => {
    // Negative control for the rule itself: it must not be trivially true.
    // A standard case IS a door, so this coalescing row is allowed...
    expect(chain('IfcDoorStandardCase')).toContain('IfcDoor');
    expect(IfcTypeEnumToString(IfcTypeEnumFromString('IfcDoorStandardCase'))).toBe('IfcDoor');

    // ...while a sibling is not, so the same predicate rejects it. If this
    // ever passes, `chain` has stopped discriminating and the sweep above is
    // worthless.
    expect(chain('IfcWall')).not.toContain('IfcSpace');
    expect(chain('IfcTendonAnchor')).not.toContain('IfcTendon');
  });
});
