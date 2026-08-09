/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  buildComponentFingerprints,
  buildDataFingerprint,
  normalizeValue,
  stableHash,
  type DataFingerprintInput,
} from './fingerprint.js';

describe('stableHash', () => {
  it('is deterministic and distinguishes inputs', () => {
    expect(stableHash('hello')).toBe(stableHash('hello'));
    expect(stableHash('hello')).not.toBe(stableHash('world'));
  });

  it('is 64 bits wide — 16 zero-padded hex chars, whatever the leading nibbles', () => {
    // The width is what makes hash equality usable as identity in the
    // content-matching pass (issue #1962), so it is pinned, not incidental.
    // 'a' hashes to af63... and '  ' (two spaces) to 07c5..., so the
    // zero-padding branch is genuinely exercised, not merely asserted.
    for (const input of ['', 'a', 'hello', '  ', JSON.stringify({ Type: 'IfcWall' })]) {
      expect(stableHash(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('matches the canonical FNV-1a-64 vectors (same constants as determinism.rs)', () => {
    // Offset basis 0xcbf29ce484222325, prime 0x100000001b3. For ASCII input
    // the UTF-16-code-unit walk is byte-identical to the reference byte walk,
    // so the published vectors apply and pin both constants exactly.
    expect(stableHash('')).toBe('cbf29ce484222325');
    expect(stableHash('a')).toBe('af63dc4c8601ec8c');
    expect(stableHash('hello')).toBe('a430d84680aabd0b');
  });
});

describe('normalizeValue', () => {
  it('passes scalars through and serializes objects', () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue('x')).toBe('x');
    expect(normalizeValue(3)).toBe(3);
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('buildDataFingerprint', () => {
  it('is independent of property-set / member / type-assignment ordering', () => {
    const a: DataFingerprintInput = {
      ifcType: 'IfcWall',
      name: 'W1',
      propertySets: [
        { name: 'Pset_A', properties: [{ name: 'x', value: 1 }, { name: 'y', value: 2 }] },
        { name: 'Pset_B', properties: [{ name: 'z', value: 3 }] },
      ],
      quantitySets: [{ name: 'Qto', quantities: [{ name: 'Vol', value: 10 }] }],
      typeAssignments: [
        { globalId: 'g1', name: 'T1', type: 'IfcWallType' },
        { globalId: 'g2', name: 'T2', type: 'IfcWallType' },
      ],
    };
    const shuffled: DataFingerprintInput = {
      ifcType: 'IfcWall',
      name: 'W1',
      propertySets: [
        { name: 'Pset_B', properties: [{ name: 'z', value: 3 }] },
        { name: 'Pset_A', properties: [{ name: 'y', value: 2 }, { name: 'x', value: 1 }] },
      ],
      quantitySets: [{ name: 'Qto', quantities: [{ name: 'Vol', value: 10 }] }],
      typeAssignments: [
        { globalId: 'g2', name: 'T2', type: 'IfcWallType' },
        { globalId: 'g1', name: 'T1', type: 'IfcWallType' },
      ],
    };
    expect(buildDataFingerprint(a)).toBe(buildDataFingerprint(shuffled));
  });

  it('changes when a property value changes', () => {
    const base: DataFingerprintInput = {
      ifcType: 'IfcWall',
      propertySets: [{ name: 'Pset', properties: [{ name: 'Fire', value: 'A' }] }],
    };
    const edited: DataFingerprintInput = {
      ifcType: 'IfcWall',
      propertySets: [{ name: 'Pset', properties: [{ name: 'Fire', value: 'B' }] }],
    };
    expect(buildDataFingerprint(base)).not.toBe(buildDataFingerprint(edited));
  });

  it('changes when the IFC type or core attributes change', () => {
    const base: DataFingerprintInput = { ifcType: 'IfcWall', name: 'W' };
    expect(buildDataFingerprint(base)).not.toBe(
      buildDataFingerprint({ ...base, ifcType: 'IfcWallStandardCase' }),
    );
    expect(buildDataFingerprint(base)).not.toBe(buildDataFingerprint({ ...base, name: 'W2' }));
  });

  it('includes PredefinedType — value vs unset differ (issue #1361)', () => {
    // A re-export that drops `.POST.` → `$` is a real change a coordinator may
    // want to see; the fingerprint must reflect it. (Bonsai's default diff is
    // attribute-blind and would not, which is the reported discrepancy.)
    const withType: DataFingerprintInput = { ifcType: 'IfcMember', name: 'member', predefinedType: 'POST' };
    const unset: DataFingerprintInput = { ifcType: 'IfcMember', name: 'member' };
    expect(buildDataFingerprint(withType)).not.toBe(buildDataFingerprint(unset));
    // An unset PredefinedType hashes identically to an explicit-empty one.
    expect(buildDataFingerprint(unset)).toBe(
      buildDataFingerprint({ ...unset, predefinedType: '' }),
    );
  });

  it('separates two type objects that differ only in Tag (issue #2021)', () => {
    // Duplex, verbatim: eight `IfcFurnitureType` entities all named '800 mm',
    // equal in every other attribute this hashes, separable only by Tag. A type
    // object carries no geometry hash, so before this they shared one content
    // bucket with nothing left to tell them apart and the engine — correctly,
    // on the evidence it had — abstained on all eight.
    const furnitureType = (tag: string): DataFingerprintInput => ({
      ifcType: 'IfcFurnitureType',
      name: '800 mm',
      objectType: '800 mm',
      predefinedType: 'NOTDEFINED',
      tag,
    });
    expect(buildDataFingerprint(furnitureType('157200'))).not.toBe(
      buildDataFingerprint(furnitureType('157607')),
    );
    // An unset Tag hashes identically to an explicit-empty one, so an adapter
    // that omits the field and one that supplies '' agree.
    expect(buildDataFingerprint({ ifcType: 'IfcFurnitureType', name: '800 mm' })).toBe(
      buildDataFingerprint({ ifcType: 'IfcFurnitureType', name: '800 mm', tag: '' }),
    );
  });

  it('separates the three content pairs that collided at 32 bits (issue #1962)', () => {
    // Found by enumerating the old 32-bit `stableHash`. Each pair is genuinely
    // different content that hashed identically, and under
    // `matchUnpairedByContent` the third pair would have been silently retired
    // as a renamed match. They are the concrete evidence that widening bought
    // something, not just a different set of digits.
    const withReference = (reference: string): DataFingerprintInput => ({
      ifcType: 'IfcWall',
      name: 'Wall',
      propertySets: [
        { name: 'Pset_WallCommon', properties: [{ name: 'Reference', value: reference }] },
      ],
    });
    const pairs: [DataFingerprintInput, DataFingerprintInput][] = [
      [
        { ifcType: 'IfcWall', name: 'W-168484' },
        { ifcType: 'IfcDoor', name: 'D-35800' },
      ],
      [withReference('R-1129599'), withReference('R-1732382')],
      [
        { ifcType: 'IfcWall', name: 'W-129599' },
        { ifcType: 'IfcWall', name: 'W-732382' },
      ],
    ];
    for (const [a, b] of pairs) {
      expect(buildDataFingerprint(a)).not.toBe(buildDataFingerprint(b));
    }
  });

  it('ignores the assigned type’s GlobalId — a re-GUIDed type still hashes equal', () => {
    // The scenario `matchUnpairedByContent` exists for: a from-scratch
    // re-export regenerates every IfcRoot's GlobalId, and IfcTypeObject is an
    // IfcRoot. If the type's GlobalId were hashed, every *typed* element in
    // the model would fail to content-match on a re-export where nothing
    // substantive changed.
    const base: DataFingerprintInput = {
      ifcType: 'IfcWall',
      name: 'W1',
      typeAssignments: [{ globalId: '0aBc$before000000000001', name: 'WT-200', type: 'IfcWallType' }],
    };
    const reExported: DataFingerprintInput = {
      ...base,
      typeAssignments: [{ globalId: '3xYz_after0000000000002', name: 'WT-200', type: 'IfcWallType' }],
    };
    expect(buildDataFingerprint(reExported)).toBe(buildDataFingerprint(base));
    // An absent globalId is likewise indistinguishable from any present one.
    expect(
      buildDataFingerprint({ ...base, typeAssignments: [{ name: 'WT-200', type: 'IfcWallType' }] }),
    ).toBe(buildDataFingerprint(base));
  });

  it('still separates a different assigned-type name or class', () => {
    // The other half of the trade: name + class is what carries the type's
    // identity now, so both must remain load-bearing.
    const base: DataFingerprintInput = {
      ifcType: 'IfcWall',
      name: 'W1',
      typeAssignments: [{ globalId: 'g', name: 'WT-200', type: 'IfcWallType' }],
    };
    expect(
      buildDataFingerprint({
        ...base,
        typeAssignments: [{ globalId: 'g', name: 'WT-300', type: 'IfcWallType' }],
      }),
    ).not.toBe(buildDataFingerprint(base));
    expect(
      buildDataFingerprint({
        ...base,
        typeAssignments: [{ globalId: 'g', name: 'WT-200', type: 'IfcWallStandardCaseType' }],
      }),
    ).not.toBe(buildDataFingerprint(base));
    // Losing the assignment entirely is still a change.
    expect(buildDataFingerprint({ ...base, typeAssignments: [] })).not.toBe(
      buildDataFingerprint(base),
    );
  });

  it('keeps duplicate assignments rather than collapsing them', () => {
    // Cardinality is content: IFC allows an occurrence at most one
    // IfcRelDefinesByType, so two same-named assignments are an anomaly the
    // diff should surface, not normalize away.
    const one: DataFingerprintInput = {
      ifcType: 'IfcWall',
      typeAssignments: [{ name: 'WT-200', type: 'IfcWallType' }],
    };
    const two: DataFingerprintInput = {
      ifcType: 'IfcWall',
      typeAssignments: [
        { globalId: 'a', name: 'WT-200', type: 'IfcWallType' },
        { globalId: 'b', name: 'WT-200', type: 'IfcWallType' },
      ],
    };
    expect(buildDataFingerprint(two)).not.toBe(buildDataFingerprint(one));
    // ...and the pair is order-independent even though (name, class) ties and
    // globalId is no longer a tiebreaker: the projected records are identical,
    // so their relative order cannot reach the serialization.
    const swapped: DataFingerprintInput = {
      ifcType: 'IfcWall',
      typeAssignments: [
        { globalId: 'b', name: 'WT-200', type: 'IfcWallType' },
        { globalId: 'a', name: 'WT-200', type: 'IfcWallType' },
      ],
    };
    expect(buildDataFingerprint(swapped)).toBe(buildDataFingerprint(two));
  });

  it('treats absent optional collections as empty (stable)', () => {
    expect(buildDataFingerprint({ ifcType: 'IfcWall' })).toBe(
      buildDataFingerprint({
        ifcType: 'IfcWall',
        propertySets: [],
        quantitySets: [],
        typeAssignments: [],
      }),
    );
  });
});

describe('stableHash / buildDataFingerprint — locale independence', () => {
  // Raised MAJOR by a CodeRabbit CLI review of #1987. Every sort in this module
  // feeds a `JSON.stringify` that is then hashed, so a locale-sensitive
  // comparator makes `dataHash` depend on the MACHINE, not the content:
  // `'B'.localeCompare('ä')` is negative under en-US and positive under
  // sv-SE. That is fatal for a hash whose entire purpose is cross-machine
  // identity — base fingerprinted on one host, head on another.
  const psets = (names: string[]) => ({
    ifcType: 'IfcWall',
    propertySets: names.map((name) => ({ name, properties: [{ name: 'P', value: 1 }] })),
  });

  it('orders property sets by UTF-16 code unit, not by any collation', () => {
    // Character choice is load-bearing. My first version used 'B' vs the
    // a-umlaut, which distinguishes the two orderings under en-US but NOT
    // under sv-SE (where collation happens to agree with code-unit order) —
    // a locale-independence test that was itself locale-dependent, caught in
    // review. 'a' vs 'B' has no such hole: code units put 'B' (0x42) first,
    // and every collation puts 'a' first, so the two disagree everywhere.
    const a = buildDataFingerprint(psets(['B', 'a']));
    const b = buildDataFingerprint(psets(['a', 'B']));
    expect(a, 'input order must not matter').toBe(b);

    const codeUnitOrder = buildDataFingerprint(psets(['B', 'a']));
    const collationOrder = stableHash(
      JSON.stringify({
        Type: 'IfcWall',
        Name: '',
        Description: '',
        ObjectType: '',
        PredefinedType: '',
        TypeAssignments: [],
        PropertySets: [
          { name: 'a', properties: [{ name: 'P', value: 1 }] },
          { name: 'B', properties: [{ name: 'P', value: 1 }] },
        ],
        QuantitySets: [],
      }),
    );
    expect(
      codeUnitOrder,
      'the two orderings must be distinguishable, or this test proves nothing',
    ).not.toBe(collationOrder);
  });

  it('never calls localeCompare at all, whatever the runner locale is', () => {
    // The strongest form, and independent of which characters or locale the
    // runner happens to have: assert the collation API is never reached.
    // A regression cannot hide behind a locale that agrees with code units.
    const original = String.prototype.localeCompare;
    let calls = 0;
    // eslint-disable-next-line no-extend-native
    String.prototype.localeCompare = function patched(this: string, ...args: unknown[]) {
      calls += 1;
      return original.apply(this, args as Parameters<typeof original>);
    };
    try {
      buildDataFingerprint({
        ifcType: 'IfcWall',
        propertySets: [
          { name: 'b', properties: [{ name: 'q', value: 1 }, { name: 'p', value: 2 }] },
          { name: 'A', properties: [{ name: 'r', value: 3 }] },
        ],
        quantitySets: [
          { name: 'zQ', quantities: [{ name: 'V', value: 1 }] },
          { name: 'aQ', quantities: [{ name: 'W', value: 2 }] },
        ],
        typeAssignments: [
          { name: 'zT', type: 'IfcWallType' },
          { name: 'aT', type: 'IfcWallType' },
        ],
      });
    } finally {
      String.prototype.localeCompare = original;
    }
    expect(calls, 'fingerprinting must not consult any collation').toBe(0);
  });

  it('gives one hash for quantity sets and type assignments whatever order they arrive in', () => {
    const forward = buildDataFingerprint({
      ifcType: 'IfcWall',
      quantitySets: [
        { name: 'äQ', quantities: [{ name: 'V', value: 2 }] },
        { name: 'BQ', quantities: [{ name: 'V', value: 2 }] },
      ],
      typeAssignments: [
        { name: 'äT', type: 'IfcWallType' },
        { name: 'BT', type: 'IfcWallType' },
      ],
    });
    const reverse = buildDataFingerprint({
      ifcType: 'IfcWall',
      quantitySets: [
        { name: 'BQ', quantities: [{ name: 'V', value: 2 }] },
        { name: 'äQ', quantities: [{ name: 'V', value: 2 }] },
      ],
      typeAssignments: [
        { name: 'BT', type: 'IfcWallType' },
        { name: 'äT', type: 'IfcWallType' },
      ],
    });
    expect(forward).toBe(reverse);
  });
});

describe('buildDataFingerprint — duplicate names cannot make the hash order-dependent', () => {
  // Found via a CodeRabbit CLI review of the example's copy (#1998), then
  // confirmed against the shipped package: sorting on `name` alone is not a
  // total order, `Array.prototype.sort` is stable, so two same-named records
  // kept their INPUT order and the hash moved with the adapter's walk order.
  // The guide claims "collection ordering never produces a spurious modified";
  // that was false for duplicates. Same-named psets are real here — type and
  // occurrence psets of one name (#1913).
  const wall = (sets: { name: string; v: number }[]) => ({
    ifcType: 'IfcWall',
    propertySets: sets.map((s) => ({ name: s.name, properties: [{ name: 'x', value: s.v }] })),
  });

  it('two same-named property sets hash the same whichever order they arrive in', () => {
    const a = buildDataFingerprint(wall([{ name: 'P', v: 1 }, { name: 'P', v: 2 }]));
    const b = buildDataFingerprint(wall([{ name: 'P', v: 2 }, { name: 'P', v: 1 }]));
    expect(a).toBe(b);
  });

  it('still distinguishes genuinely different duplicate content', () => {
    const a = buildDataFingerprint(wall([{ name: 'P', v: 1 }, { name: 'P', v: 2 }]));
    const c = buildDataFingerprint(wall([{ name: 'P', v: 1 }, { name: 'P', v: 3 }]));
    expect(a, 'the tiebreak must not collapse distinct content').not.toBe(c);
  });

  it('same-named quantity sets and same-named properties are order-stable too', () => {
    const qs = (vals: number[]) => ({
      ifcType: 'IfcWall',
      quantitySets: vals.map((v) => ({ name: 'Q', quantities: [{ name: 'V', value: v }] })),
      propertySets: [{ name: 'P', properties: vals.map((v) => ({ name: 'dup', value: v })) }],
    });
    expect(buildDataFingerprint(qs([1, 2]))).toBe(buildDataFingerprint(qs([2, 1])));
  });
});

describe('buildDataFingerprint — resolved material names', () => {
  // Materials were not in the fingerprint at all, so a re-specified element —
  // measured case: two proxies whose material went `Soil1` -> `topsoil` — read
  // as unchanged in every channel.
  const proxy = (materials?: string[]): DataFingerprintInput => ({
    ifcType: 'IfcBuildingElementProxy',
    name: 'road - roadside verge - soil',
    ...(materials ? { materials } : {}),
  });

  it('moves the hash when the resolved material name changes', () => {
    expect(buildDataFingerprint(proxy(['Soil1']))).not.toBe(
      buildDataFingerprint(proxy(['topsoil'])),
    );
  });

  it('separates gaining a material from having none', () => {
    expect(buildDataFingerprint(proxy())).not.toBe(buildDataFingerprint(proxy(['Soil1'])));
  });

  it('leaves an element with no materials hashing exactly as an empty list', () => {
    // Absent and empty are the same statement — "this element names no
    // material" — and an adapter that supplies `[]` rather than omitting the
    // field must not fork the hash of every material-less element in the model.
    expect(buildDataFingerprint(proxy())).toBe(buildDataFingerprint(proxy([])));
  });

  it('is order-independent, so a re-export that walks associations differently still matches', () => {
    expect(buildDataFingerprint(proxy(['insulation', 'gypsumboard']))).toBe(
      buildDataFingerprint(proxy(['gypsumboard', 'insulation'])),
    );
  });

  it('does not confuse a material name with an equally-named property or type', () => {
    // The projection is keyed, not concatenated: moving a string between slots
    // must move the hash.
    const asMaterial = buildDataFingerprint(proxy(['Soil1']));
    const asName = buildDataFingerprint({ ...proxy(), objectType: 'Soil1' });
    expect(asMaterial).not.toBe(asName);
  });
});

describe('buildComponentFingerprints — the material component', () => {
  const proxy = (materials?: string[]): DataFingerprintInput => ({
    ifcType: 'IfcBuildingElementProxy',
    name: 'road - roadside verge - soil',
    propertySets: [{ name: 'Pset_Common', properties: [{ name: 'Status', value: 'New' }] }],
    ...(materials ? { materials } : {}),
  });

  it('emits a `material` key only for an element that names one', () => {
    expect(buildComponentFingerprints(proxy(['Soil1']))).toHaveProperty('material');
    expect(buildComponentFingerprints(proxy())).not.toHaveProperty('material');
  });

  it('moves `material` and nothing else when the material changes', () => {
    // The sub-hashes are the content pass's collision guard, so each must track
    // exactly the slice it names — a material edit must not disturb attr:core.
    const a = buildComponentFingerprints(proxy(['Soil1']));
    const b = buildComponentFingerprints(proxy(['topsoil']));
    expect(a['material']).not.toBe(b['material']);
    expect(a['attr:core']).toBe(b['attr:core']);
    expect(a['pset:Pset_Common']).toBe(b['pset:Pset_Common']);
  });
});
