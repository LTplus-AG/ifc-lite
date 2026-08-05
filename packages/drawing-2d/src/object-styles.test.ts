/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isIfcTypeVisible, getHiddenIfcTypes } from './object-styles.js';

describe('isIfcTypeVisible', () => {
  it('IfcWall is visible by default', () => {
    expect(isIfcTypeVisible('IfcWall')).toBe(true);
  });

  it('IfcOpeningElement is hidden by default', () => {
    expect(isIfcTypeVisible('IfcOpeningElement')).toBe(false);
  });

  it('a user override can hide a normally-visible type', () => {
    expect(isIfcTypeVisible('IfcWall', { IfcWall: { visible: false } })).toBe(false);
  });
});

describe('getHiddenIfcTypes', () => {
  it('includes types that are hidden by default and excludes visible ones', () => {
    const hidden = getHiddenIfcTypes();
    expect(hidden).toContain('IfcOpeningElement');
    expect(hidden).not.toContain('IfcWall');
  });

  it('reflects user overrides that hide/show types', () => {
    const hidden = getHiddenIfcTypes({
      IfcWall: { visible: false },
      IfcOpeningElement: { visible: true },
    });
    expect(hidden).toContain('IfcWall');
    expect(hidden).not.toContain('IfcOpeningElement');
  });
});
