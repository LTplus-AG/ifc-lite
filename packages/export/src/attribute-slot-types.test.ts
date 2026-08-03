/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guards for the schema-driven slot typing behind the #2006 review fixes.
 *
 * 1. `getAttributeNames` (IFC4 pin) → `getAttributeNamesAcrossSchemas`
 *    (pin, then the 2X3+4+4X3 union). The pair CAN disagree in principle, and a
 *    disagreement on ORDER would silently write values into the wrong slots, so
 *    the equivalence is measured over every class rather than reasoned about.
 * 2. Slot indices must be indices into that same name list, or the enum and
 *    string rules would fire on the wrong attribute.
 * 3. The token forms these produce must be lexically valid STEP, because a
 *    malformed token does not corrupt one attribute — it re-parses as a
 *    different number of arguments and shifts every slot after it.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SCHEMA_REGISTRY,
  getAllAttributesForEntity,
  getAttributeNames,
  getAttributeNamesAcrossSchemas,
} from '@ifc-lite/parser';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import {
  getEnumTypedSlots,
  getStringTypedSlots,
  serializeEnumToken,
  serializeStringSlot,
} from './attribute-slot-types.js';

const PINNED_CLASSES = Object.keys(SCHEMA_REGISTRY.entities);

describe('getAttributeNamesAcrossSchemas vs the IFC4 pin', () => {
  it('returns the pinned result identically — same names, same order — for every pinned class', () => {
    const differing: string[] = [];
    let compared = 0;
    for (const name of PINNED_CLASSES) {
      const pinned = getAttributeNames(name);
      if (pinned.length === 0) continue;
      compared++;
      const across = getAttributeNamesAcrossSchemas(name);
      if (pinned.length !== across.length || pinned.some((n, i) => n !== across[i])) {
        differing.push(name);
      }
    }
    // Guard against a vacuous pass if the registry ever stops loading.
    expect(compared).toBeGreaterThan(700);
    expect(differing).toEqual([]);
  });

  it('resolves the IFC4X3-only classes the pin cannot, at their declared indices', () => {
    // The whole point of the swap: these return nothing under the pin, so every
    // named attribute edit on one used to resolve to `index < 0` and vanish.
    expect(getAttributeNames('IfcCourse')).toEqual([]);
    expect(getAttributeNames('IfcRoad')).toEqual([]);

    expect(getAttributeNamesAcrossSchemas('IfcCourse')).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType',
      'ObjectPlacement', 'Representation', 'Tag', 'PredefinedType',
    ]);
    expect(getAttributeNamesAcrossSchemas('IfcRoad')).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType',
      'ObjectPlacement', 'Representation', 'LongName', 'CompositionType', 'PredefinedType',
    ]);
  });

  it('still resolves nothing for a class no bundled schema knows', () => {
    // Unknown classes keep the historical behaviour on both lookups: no slots,
    // so no override applies and nothing is written to a guessed index.
    expect(getAttributeNames('IfcVendorExtensionThing')).toEqual([]);
    expect(getAttributeNamesAcrossSchemas('IfcVendorExtensionThing')).toEqual([]);
    expect([...getEnumTypedSlots('IfcVendorExtensionThing')]).toEqual([]);
  });
});

describe('getEnumTypedSlots', () => {
  it('reports every enum slot as an index into the cross-schema name list', () => {
    let classesWithEnums = 0;
    let enumSlots = 0;
    for (const name of PINNED_CLASSES) {
      const names = getAttributeNamesAcrossSchemas(name);
      const meta = getAllAttributesForEntity(name);
      const slots = getEnumTypedSlots(name);
      if (slots.size > 0) classesWithEnums++;
      for (const index of slots) {
        enumSlots++;
        // In range of the list the exporter indexes with...
        expect(index, `${name} slot ${index}`).toBeLessThan(names.length);
        // ...and genuinely enum-typed at that index, not merely in range.
        // A pinned class always has metadata to check against; the union
        // fallback (measured: no pinned class reaches it) can only ever claim
        // PredefinedType, so hold it to that.
        if (meta.length > 0) {
          expect(SCHEMA_REGISTRY.enums[meta[index].type], `${name}.${names[index]}`).toBeDefined();
        } else {
          expect(names[index], `${name} slot ${index}`).toBe('PredefinedType');
        }
      }
    }
    expect(classesWithEnums).toBeGreaterThan(300);
    expect(enumSlots).toBeGreaterThan(300);
  });

  // The inherited-slot types come from the nearest pinned ancestor, matched BY
  // NAME. Reusing the ancestor's INDICES would be wrong: its attribute list is
  // not always a prefix of the leaf's (measured: 30 of the 169 classes with a
  // pinned ancestor), and here index 10 is `ProjectedOrTrue` in the ancestor
  // and `CausedBy` in the leaf — so index reuse would mark a reference slot as
  // an enum and write `.SOMETHING.` into it.
  it('places an inherited enum at the LEAF index, not the ancestor index', () => {
    const names = getAttributeNamesAcrossSchemas('IfcStructuralLinearActionVarying');
    expect(getAttributeNames('IfcStructuralLinearActionVarying')).toEqual([]);
    expect(names[10]).toBe('CausedBy');
    expect(names[11]).toBe('ProjectedOrTrue');

    const slots = getEnumTypedSlots('IfcStructuralLinearActionVarying');
    expect(slots.has(11)).toBe(true);
    expect(slots.has(10)).toBe(false);
    expect(slots.has(names.indexOf('GlobalOrLocal'))).toBe(true);
  });

  it('resolves an inherited enum on a class whose ancestor chain crosses unpinned classes', () => {
    // IfcRoad → IfcFacility (unpinned too) → IfcSpatialStructureElement, which
    // declares CompositionType as IfcElementCompositionEnum.
    const names = getAttributeNamesAcrossSchemas('IfcRoad');
    expect(names[8]).toBe('CompositionType');
    expect(getEnumTypedSlots('IfcRoad').has(8)).toBe(true);
  });

  it('canonicalizes alias names so every alias of a class answers alike', () => {
    const canonical = getEnumTypedSlots('IfcGeotechnicalStratum');
    expect([...canonical]).toEqual([8]);
    expect([...getEnumTypedSlots('IfcSolidStratum')]).toEqual([...canonical]);
    expect([...getEnumTypedSlots('IfcWaterStratum')]).toEqual([...canonical]);
    expect([...getEnumTypedSlots('IFCVOIDSTRATUM')]).toEqual([...canonical]);
  });

  it('finds PredefinedType on an IFC4X3-only class the pin does not carry', () => {
    const names = getAttributeNamesAcrossSchemas('IfcCourse');
    expect([...getEnumTypedSlots('IfcCourse')]).toEqual([names.indexOf('PredefinedType')]);
    expect(names.indexOf('PredefinedType')).toBe(8);
  });

  it('does not claim a non-enum slot', () => {
    const names = getAttributeNamesAcrossSchemas('IfcWall');
    const slots = getEnumTypedSlots('IfcWall');
    expect([...slots]).toEqual([names.indexOf('PredefinedType')]);
    expect(slots.has(names.indexOf('Name'))).toBe(false);
    expect(slots.has(names.indexOf('Tag'))).toBe(false);
  });

  it('agrees with the union data set on which classes declare a PredefinedType domain', () => {
    // Cross-check against a source the implementation does not consult for
    // pinned classes: the bundled schema union.
    const union = new Map<string, readonly string[]>();
    for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
      for (const entity of list) union.set(entity.name.toUpperCase(), entity.attributes);
    }
    for (const name of ['IfcWall', 'IfcColumn', 'IfcBeam', 'IfcSlab']) {
      const attrs = union.get(name.toUpperCase())!;
      expect(getEnumTypedSlots(name).has(attrs.indexOf('PredefinedType'))).toBe(true);
    }
  });
});

describe('getStringTypedSlots', () => {
  it('claims the text slots and leaves reference/enum/numeric slots alone', () => {
    const names = getAttributeNamesAcrossSchemas('IfcWall');
    const strings = getStringTypedSlots('IfcWall');
    for (const name of ['GlobalId', 'Name', 'Description', 'ObjectType', 'Tag']) {
      expect(strings.has(names.indexOf(name)), name).toBe(true);
    }
    // A bare `#12` is the CORRECT token in these, which is why they must not
    // be force-quoted.
    for (const name of ['OwnerHistory', 'ObjectPlacement', 'Representation']) {
      expect(strings.has(names.indexOf(name)), name).toBe(false);
    }
    // Enum and string classification are disjoint.
    expect(strings.has(names.indexOf('PredefinedType'))).toBe(false);
  });

  it('resolves text slots on an unpinned class through the pinned ancestor', () => {
    const names = getAttributeNamesAcrossSchemas('IfcRoad');
    const strings = getStringTypedSlots('IfcRoad');
    expect(strings.has(names.indexOf('Name'))).toBe(true);
    expect(strings.has(names.indexOf('LongName'))).toBe(true);
    expect(strings.has(names.indexOf('ObjectPlacement'))).toBe(false);
  });

  it('does not force-quote a numeric slot', () => {
    const names = getAttributeNamesAcrossSchemas('IfcBuildingStorey');
    expect(getStringTypedSlots('IfcBuildingStorey').has(names.indexOf('Elevation'))).toBe(false);
  });
});

describe('serializeStringSlot', () => {
  it('quotes a value that merely looks like a STEP token', () => {
    // The reported failure: over a `$` slot these were emitted as the tokens
    // they resemble, so a room named `#12` became an entity reference.
    expect(serializeStringSlot('#12')).toBe("'#12'");
    expect(serializeStringSlot('.FOO.')).toBe("'.FOO.'");
    expect(serializeStringSlot('12')).toBe("'12'");
    expect(serializeStringSlot('.T.')).toBe("'.T.'");
  });

  it('escapes quotes rather than breaking the literal', () => {
    expect(serializeStringSlot("O'Brien")).toBe("'O''Brien'");
  });

  it('keeps the null and derived markers', () => {
    expect(serializeStringSlot('')).toBe('$');
    expect(serializeStringSlot('$')).toBe('$');
    expect(serializeStringSlot('*')).toBe('*');
  });
});

describe('serializeEnumToken', () => {
  it('emits an enumeration token from a bare symbol or an already-dotted one', () => {
    expect(serializeEnumToken('USERDEFINED')).toBe('.USERDEFINED.');
    expect(serializeEnumToken('.USERDEFINED.')).toBe('.USERDEFINED.');
    expect(serializeEnumToken('userdefined')).toBe('.USERDEFINED.');
    expect(serializeEnumToken('  SOLIDWALL  ')).toBe('.SOLIDWALL.');
  });

  it('maps the empty and null forms to `$` rather than an empty enum', () => {
    expect(serializeEnumToken('')).toBe('$');
    expect(serializeEnumToken('  ')).toBe('$');
    expect(serializeEnumToken('$')).toBe('$');
    expect(serializeEnumToken('..')).toBe('$');
    expect(serializeEnumToken('*')).toBe('*');
  });

  it('falls back to a quoted string for anything that is not a token, loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // `.A,B.` would re-parse as TWO arguments and shift every following slot;
      // `.O'BRIEN.` opens a string literal that swallows the rest of the record.
      // Containing the damage to one slot beats corrupting the whole entity.
      expect(serializeEnumToken('A,B')).toBe("'A,B'");
      // The fallback keeps the caller's original casing: if the value is not
      // an enum symbol it is text, and text is not upper-cased.
      expect(serializeEnumToken("O'Brien")).toBe("'O''Brien'");
      expect(serializeEnumToken('A(B)')).toBe("'A(B)'");
      expect(serializeEnumToken('A;B')).toBe("'A;B'");
      expect(serializeEnumToken('A B')).toBe("'A B'");
      expect(serializeEnumToken('2HOUR')).toBe("'2HOUR'");
      // Loudly: silence is how a corrupt record ships unnoticed.
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts every enumeration value the bundled schemas actually declare', () => {
    // The guard must not reject real data. If any legitimate IFC enum symbol
    // failed the lexical test it would silently become a quoted string, which
    // is the same class of corruption in the other direction.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let checked = 0;
      for (const values of Object.values(SCHEMA_REGISTRY.enums)) {
        for (const value of values) {
          checked++;
          expect(serializeEnumToken(value), value).toBe(`.${value.toUpperCase()}.`);
        }
      }
      for (const list of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
        for (const entity of list) {
          for (const value of entity.predefinedTypes) {
            checked++;
            expect(serializeEnumToken(value), `${entity.name}.${value}`).toBe(`.${value.toUpperCase()}.`);
          }
        }
      }
      expect(checked).toBeGreaterThan(5000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
