/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `isInstantiable` answers `known && !abstract`, the predicate an authoring
 * boundary actually needs (#2035).
 *
 * `isKnownType` answers a different question — "is this a real EXPRESS class
 * name" — and always has: it says `true` for `IfcProduct`, `IfcRoot` and
 * `IfcRelationship`, which are real classes but EXPRESS `ABSTRACT
 * SUPERTYPE`s. Before `isInstantiable` existed, nothing separated "real
 * class" from "instantiable class", so `@ifc-lite/sdk`'s `addEntity` guard
 * (which only checked `isKnownType`) would accept `addEntity('IfcProduct',
 * …)` and write an invalid `#N=IFCPRODUCT(...)` STEP record.
 *
 * Resolves across the bundled schema union (2X3 + 4 + 4X3) first, falling
 * back to the codegen pin — same order as `isKnownType` — so an
 * IFC4X3-only concrete class (`IfcRoad`) is not mistaken for abstract just
 * because the pin doesn't carry it.
 */

import { describe, it, expect } from 'vitest';
import { isInstantiable, isKnownType } from '../src/ifc-schema.js';

describe('isInstantiable (#2035)', () => {
  it('rejects abstract EXPRESS supertypes that isKnownType accepts', () => {
    for (const type of ['IfcProduct', 'IfcRoot', 'IfcRelationship', 'IfcElement', 'IfcSpatialStructureElement']) {
      expect(isKnownType(type), `${type} should still be known`).toBe(true);
      expect(isInstantiable(type), `${type} should not be instantiable`).toBe(false);
    }
  });

  it('accepts concrete leaf classes', () => {
    for (const type of ['IfcWall', 'IfcDoor', 'IfcWindow', 'IfcBeam']) {
      expect(isInstantiable(type)).toBe(true);
    }
  });

  it('accepts a concrete class outside the IFC4 codegen pin (cross-schema union)', () => {
    // IfcRoad is IFC4X3-only infrastructure and concrete.
    expect(isKnownType('IfcRoad')).toBe(true);
    expect(isInstantiable('IfcRoad')).toBe(true);
  });

  it('rejects an unknown name (typo) the same way isKnownType does', () => {
    expect(isKnownType('IfcWal')).toBe(false);
    expect(isInstantiable('IfcWal')).toBe(false);
  });

  it('rejects an EXPRESS defined type, which is not an entity at all', () => {
    expect(isKnownType('IfcLengthMeasure')).toBe(false);
    expect(isInstantiable('IfcLengthMeasure')).toBe(false);
  });
});
