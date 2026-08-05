/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the shared IFC-class → type-visibility mapping.
 * Locks in issue #1480: the `site` toggle governs `IfcGeographicElement`
 * terrain, not just `IfcSite`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTypeVisible, buildHiddenIfcTypes } from './typeVisibilityFilter.js';

const ALL_ON = {
  spaces: true,
  spatialZones: true,
  openings: true,
  virtualElements: true,
  site: true,
  ifcAnnotations: true,
};

describe('isTypeVisible', () => {
  it('shows every mapped class when all toggles are on', () => {
    for (const t of ['IfcSite', 'IfcGeographicElement', 'IfcSpace', 'IfcOpeningElement', 'IfcAnnotation']) {
      assert.equal(isTypeVisible(t, ALL_ON), true, t);
    }
  });

  it('hides IfcGeographicElement (terrain) when site is off (issue #1480)', () => {
    const tv = { ...ALL_ON, site: false };
    assert.equal(isTypeVisible('IfcGeographicElement', tv), false);
    assert.equal(isTypeVisible('IfcSite', tv), false);
  });

  it('leaves unmapped classes (walls, slabs) always visible', () => {
    const allOff = { spaces: false, spatialZones: false, openings: false, virtualElements: false, site: false, ifcAnnotations: false };
    assert.equal(isTypeVisible('IfcWall', allOff), true);
    assert.equal(isTypeVisible('IfcBuildingElementProxy', allOff), true);
  });

  it('treats an undefined ifcType as visible', () => {
    assert.equal(isTypeVisible(undefined, { ...ALL_ON, site: false }), true);
  });

  it('gates each class on exactly its own toggle', () => {
    assert.equal(isTypeVisible('IfcSpace', { ...ALL_ON, spaces: false }), false);
    assert.equal(isTypeVisible('IfcSpace', { ...ALL_ON, site: false }), true);
    assert.equal(isTypeVisible('IfcAnnotation', { ...ALL_ON, ifcAnnotations: false }), false);
  });

  it('measures EVERY class→toggle pair independently, in both directions', () => {
    // Per-case measurement: the loop above only ever discriminated
    // `spaces`, `site` and `ifcAnnotations`, so `IfcSpatialZone`,
    // `IfcOpeningElement` and `IfcVirtualElement` could be remapped to each
    // other's toggle with the whole suite still green. On screen that means
    // the Openings switch hides virtual elements and leaves the openings
    // visible (or vice versa).
    const pairs: ReadonlyArray<readonly [string, keyof typeof ALL_ON]> = [
      ['IfcSpace', 'spaces'],
      ['IfcSpatialZone', 'spatialZones'],
      ['IfcOpeningElement', 'openings'],
      ['IfcVirtualElement', 'virtualElements'],
      ['IfcSite', 'site'],
      ['IfcGeographicElement', 'site'],
      ['IfcAnnotation', 'ifcAnnotations'],
    ];

    for (const [ifcType, ownKey] of pairs) {
      // Its own toggle off → hidden.
      assert.equal(
        isTypeVisible(ifcType, { ...ALL_ON, [ownKey]: false }),
        false,
        `${ifcType} must be hidden when ${ownKey} is off`,
      );
      // Every OTHER toggle off → still visible. This is the half that
      // catches a swapped mapping.
      for (const otherKey of Object.keys(ALL_ON) as (keyof typeof ALL_ON)[]) {
        if (otherKey === ownKey) continue;
        assert.equal(
          isTypeVisible(ifcType, { ...ALL_ON, [otherKey]: false }),
          true,
          `${ifcType} must be unaffected by the ${otherKey} toggle`,
        );
      }
    }
  });
});

describe('buildHiddenIfcTypes', () => {
  it('is empty when nothing is toggled off', () => {
    assert.equal(buildHiddenIfcTypes(ALL_ON).size, 0);
  });

  it('drops both IfcSite and IfcGeographicElement when site is off', () => {
    const hidden = buildHiddenIfcTypes({ ...ALL_ON, site: false });
    assert.ok(hidden.has('IfcSite'));
    assert.ok(hidden.has('IfcGeographicElement'));
    assert.equal(hidden.size, 2);
  });

  it('drops IfcAnnotation when annotations are off', () => {
    const hidden = buildHiddenIfcTypes({ ...ALL_ON, ifcAnnotations: false });
    assert.deepEqual([...hidden], ['IfcAnnotation']);
  });

  it('drops exactly the classes owned by each toggle, one toggle at a time', () => {
    // Mirrors the per-pair check above for the GLB-export gate, so the two
    // consumers can never disagree about which class a toggle owns.
    const expected: Record<keyof typeof ALL_ON, string[]> = {
      spaces: ['IfcSpace'],
      spatialZones: ['IfcSpatialZone'],
      openings: ['IfcOpeningElement'],
      virtualElements: ['IfcVirtualElement'],
      site: ['IfcSite', 'IfcGeographicElement'],
      ifcAnnotations: ['IfcAnnotation'],
    };

    for (const [key, classes] of Object.entries(expected) as [keyof typeof ALL_ON, string[]][]) {
      const hidden = buildHiddenIfcTypes({ ...ALL_ON, [key]: false });
      assert.deepEqual([...hidden].sort(), [...classes].sort(), `toggle ${key}`);
    }
  });

  it('hides every mapped class when all toggles are off', () => {
    const allOff = {
      spaces: false, spatialZones: false, openings: false,
      virtualElements: false, site: false, ifcAnnotations: false,
    };
    assert.deepEqual([...buildHiddenIfcTypes(allOff)].sort(), [
      'IfcAnnotation',
      'IfcGeographicElement',
      'IfcOpeningElement',
      'IfcSite',
      'IfcSpace',
      'IfcSpatialZone',
      'IfcVirtualElement',
    ]);
  });
});
