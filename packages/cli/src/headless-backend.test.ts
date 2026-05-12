/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  expandTypes,
  isProductType,
  normalizeBooleanValue,
  normalizePropertyValue,
} from './headless-backend.js';

describe('expandTypes', () => {
  it('expands IfcWall to include subtypes', () => {
    const result = expandTypes(['IfcWall']);
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).toContain('IFCWALLELEMENTEDCASE');
  });

  it('expands IfcSlab with 3 subtypes', () => {
    const result = expandTypes(['IfcSlab']);
    expect(result).toContain('IFCSLAB');
    expect(result).toContain('IFCSLABSTANDARDCASE');
    expect(result).toContain('IFCSLABELEMENTEDCASE');
  });

  it('handles types without subtypes', () => {
    const result = expandTypes(['IfcRoof']);
    expect(result).toEqual(['IFCROOF']);
  });

  it('handles multiple input types', () => {
    const result = expandTypes(['IfcWall', 'IfcRoof']);
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
    expect(result).toContain('IFCROOF');
  });

  it('handles empty input', () => {
    expect(expandTypes([])).toEqual([]);
  });

  it('is case-insensitive', () => {
    const result = expandTypes(['ifcwall']);
    expect(result).toContain('IFCWALL');
    expect(result).toContain('IFCWALLSTANDARDCASE');
  });
});

describe('isProductType', () => {
  it('returns false for relationship types', () => {
    expect(isProductType('IFCRELAGGREGATES')).toBe(false);
    expect(isProductType('IFCRELCONTAINEDINSPATIALSTRUCTURE')).toBe(false);
    expect(isProductType('IFCRELDEFINESBYTYPE')).toBe(false);
  });

  it('returns false for property types', () => {
    expect(isProductType('IFCPROPERTYSINGLEVALUE')).toBe(false);
    expect(isProductType('IFCPROPERTYSET')).toBe(false);
  });

  it('returns false for quantity types', () => {
    expect(isProductType('IFCQUANTITYLENGTH')).toBe(false);
    expect(isProductType('IFCELEMENTQUANTITY')).toBe(false);
  });

  it('returns false for type objects (ending with TYPE)', () => {
    expect(isProductType('IFCWALLTYPE')).toBe(false);
    expect(isProductType('IFCSLABTYPE')).toBe(false);
  });
});

describe('normalizeBooleanValue', () => {
  it('normalizes true values to "true"', () => {
    expect(normalizeBooleanValue(true)).toBe('true');
    expect(normalizeBooleanValue('.T.')).toBe('true');
    expect(normalizeBooleanValue('true')).toBe('true');
    expect(normalizeBooleanValue('TRUE')).toBe('true');
  });

  it('normalizes false values to "false"', () => {
    expect(normalizeBooleanValue(false)).toBe('false');
    expect(normalizeBooleanValue('.F.')).toBe('false');
    expect(normalizeBooleanValue('false')).toBe('false');
    expect(normalizeBooleanValue('FALSE')).toBe('false');
  });

  it('passes through non-boolean values unchanged', () => {
    expect(normalizeBooleanValue('hello')).toBe('hello');
    expect(normalizeBooleanValue(42)).toBe(42);
    expect(normalizeBooleanValue(null)).toBe(null);
  });
});

describe('normalizePropertyValue', () => {
  it('returns null for null/undefined', () => {
    expect(normalizePropertyValue(null)).toBeNull();
    expect(normalizePropertyValue(undefined)).toBeNull();
  });

  it('passes through primitives', () => {
    expect(normalizePropertyValue('hello')).toBe('hello');
    expect(normalizePropertyValue(42)).toBe(42);
    expect(normalizePropertyValue(true)).toBe(true);
  });

  it('JSON-stringifies objects and arrays', () => {
    expect(normalizePropertyValue({ key: 'val' })).toBe('{"key":"val"}');
    expect(normalizePropertyValue([1, 2, 3])).toBe('[1,2,3]');
  });
});
