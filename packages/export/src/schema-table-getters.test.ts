/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The getters production code now reads (so loading this package decodes no
 * schema table) return the very objects the exported constants are: the same
 * sets in the same order, and the parser's IFC4 pin.
 */

import { describe, it, expect } from 'vitest';
import { SCHEMA_REGISTRY } from '@ifc-lite/parser';
import { PRODUCT_TYPES, getProductTypes } from './entity-type-sets.js';
import { IFC_ROOT_TYPES, getIfcRootTypes } from './subset-roots.js';
import { ifc4Registry } from './ifc4-registry.js';

describe('export schema-table getters', () => {
  it('getProductTypes() is PRODUCT_TYPES', () => {
    expect(getProductTypes()).toBe(PRODUCT_TYPES);
    expect(PRODUCT_TYPES.has('IFCWALL')).toBe(true);
  });

  it('getIfcRootTypes() is IFC_ROOT_TYPES', () => {
    expect(getIfcRootTypes()).toBe(IFC_ROOT_TYPES);
    expect(IFC_ROOT_TYPES.has('IFCPROJECT')).toBe(true);
  });

  it('ifc4Registry() is the parser IFC4 pin SCHEMA_REGISTRY', () => {
    expect(ifc4Registry()).toBe(SCHEMA_REGISTRY);
  });
});
