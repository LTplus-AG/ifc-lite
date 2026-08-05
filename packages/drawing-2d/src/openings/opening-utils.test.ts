/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  isHostElement,
  isOpeningElement,
  isDoorOrWindow,
  filterOutOpeningElements,
  getHostEntityIds,
} from './opening-utils.js';
import type { OpeningRelationships } from '../types.js';

describe('isHostElement', () => {
  it('returns true for wall/slab/roof/floor types', () => {
    expect(isHostElement('IfcWall')).toBe(true);
    expect(isHostElement('IfcWallStandardCase')).toBe(true);
    expect(isHostElement('IfcSlab')).toBe(true);
    expect(isHostElement('IfcRoof')).toBe(true);
    expect(isHostElement('IfcFloor')).toBe(true);
  });

  it('returns false for non-host types like doors and windows', () => {
    expect(isHostElement('IfcDoor')).toBe(false);
    expect(isHostElement('IfcWindow')).toBe(false);
    expect(isHostElement('IfcFurniture')).toBe(false);
  });
});

describe('isOpeningElement / isDoorOrWindow', () => {
  it('identifies opening element types', () => {
    expect(isOpeningElement('IfcOpeningElement')).toBe(true);
    expect(isOpeningElement('IfcWall')).toBe(false);
  });

  it('identifies door/window types', () => {
    expect(isDoorOrWindow('IfcDoor')).toBe(true);
    expect(isDoorOrWindow('IfcWindow')).toBe(true);
    expect(isDoorOrWindow('IfcWall')).toBe(false);
  });
});

describe('filterOutOpeningElements', () => {
  it('excludes ids that are openings or filling elements', () => {
    const relationships: OpeningRelationships = {
      voidedBy: new Map([[1, [10]]]),
      filledBy: new Map([[10, 20]]),
      openingInfo: new Map(),
    };
    const result = filterOutOpeningElements([1, 10, 20, 30], relationships);
    expect(result).toEqual([1, 30]);
  });
});

describe('getHostEntityIds', () => {
  it('excludes opening and door/window entities, keeps hosts', () => {
    const relationships: OpeningRelationships = {
      voidedBy: new Map(),
      filledBy: new Map(),
      openingInfo: new Map(),
    };
    const ifcTypes = new Map<number, string>([
      [1, 'IfcWall'],
      [2, 'IfcOpeningElement'],
      [3, 'IfcDoor'],
      [4, 'IfcSlab'],
    ]);
    const result = getHostEntityIds([1, 2, 3, 4], relationships, ifcTypes);
    expect(result).toEqual([1, 4]);
  });
});
