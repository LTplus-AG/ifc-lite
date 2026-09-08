/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolveReassignSchema,
  getReassignTargets,
  isKnownReassignTarget,
  isReassignableElement,
  getPredefinedTypes,
  COMMON_REASSIGN_TARGETS,
} from './ifc-class-reassign.js';

describe('resolveReassignSchema', () => {
  it('maps a 2X3 spelling (any case) to IFC2X3', () => {
    assert.strictEqual(resolveReassignSchema('IFC2X3'), 'IFC2X3');
    assert.strictEqual(resolveReassignSchema('ifc2x3'), 'IFC2X3');
  });

  it('maps a 4X3 spelling to IFC4X3', () => {
    assert.strictEqual(resolveReassignSchema('IFC4X3_ADD2'), 'IFC4X3');
  });

  it('defaults to IFC4 for a plain IFC4 spelling, null, or unknown input', () => {
    assert.strictEqual(resolveReassignSchema('IFC4'), 'IFC4');
    assert.strictEqual(resolveReassignSchema(null), 'IFC4');
    assert.strictEqual(resolveReassignSchema(undefined), 'IFC4');
    assert.strictEqual(resolveReassignSchema('nonsense'), 'IFC4');
  });
});

describe('getReassignTargets', () => {
  it('includes concrete IfcElement subtypes and excludes abstract supertypes', () => {
    const targets = getReassignTargets('IFC4');
    assert.ok(targets.includes('IfcWall'));
    assert.ok(targets.includes('IfcColumn'));
    // IfcBuildingElement and IfcElement are abstract — never offered directly.
    assert.ok(!targets.includes('IfcBuildingElement'));
    assert.ok(!targets.includes('IfcElement'));
  });

  it('excludes non-IfcElement products such as IfcSpace', () => {
    const targets = getReassignTargets('IFC4');
    assert.ok(!targets.includes('IfcSpace'));
  });

  it('excludes type entities such as IfcWallType (they are not IfcElement subtypes)', () => {
    const targets = getReassignTargets('IFC4');
    assert.ok(!targets.includes('IfcWallType'));
  });

  it('sorts the result A→Z', () => {
    const targets = getReassignTargets('IFC4');
    const sorted = [...targets].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(targets, sorted);
  });

  it('is stable across repeated calls (exercises the cache path)', () => {
    const first = getReassignTargets('IFC4');
    const second = getReassignTargets('IFC4');
    assert.deepStrictEqual(first, second);
  });
});

describe('isKnownReassignTarget', () => {
  it('is true for a concrete class regardless of casing/whitespace', () => {
    assert.strictEqual(isKnownReassignTarget('IFC4', '  ifcwall  '), true);
  });

  it('is false for an abstract class', () => {
    assert.strictEqual(isKnownReassignTarget('IFC4', 'IfcBuildingElement'), false);
  });

  it('is false for an unknown class name', () => {
    assert.strictEqual(isKnownReassignTarget('IFC4', 'IfcTotallyMadeUp'), false);
  });
});

describe('isReassignableElement', () => {
  it('is true for a concrete IfcElement subtype', () => {
    assert.strictEqual(isReassignableElement('IFC4', 'IfcWall'), true);
  });

  it('is false for a concrete non-IfcElement product (IfcSpace)', () => {
    assert.strictEqual(isReassignableElement('IFC4', 'IfcSpace'), false);
  });

  it('is false for an abstract class', () => {
    assert.strictEqual(isReassignableElement('IFC4', 'IfcBuildingElement'), false);
  });

  it('is false for an unknown class name', () => {
    assert.strictEqual(isReassignableElement('IFC4', 'IfcNotARealClass'), false);
  });
});

describe('getPredefinedTypes', () => {
  it('returns a non-empty enum domain for a class known to have one (IfcWall)', () => {
    const types = getPredefinedTypes('IFC4', 'IfcWall');
    assert.ok(types.length > 0);
    assert.ok(types.includes('NOTDEFINED'));
  });

  it('returns [] for an unknown class', () => {
    assert.deepStrictEqual(getPredefinedTypes('IFC4', 'IfcNotARealClass'), []);
  });
});

describe('COMMON_REASSIGN_TARGETS', () => {
  it('every quick-pick chip is a valid, reassignable IFC4 element', () => {
    for (const name of COMMON_REASSIGN_TARGETS) {
      assert.strictEqual(
        isReassignableElement('IFC4', name),
        true,
        `${name} should be a reassignable IfcElement subtype`,
      );
    }
  });
});
