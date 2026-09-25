/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getFillColorForType` (#5496): the `dark` argument must be additive, never
 * a behaviour change for the two existing call sites (`useDrawingExport.ts`'s
 * SVG/PDF export, and the sheet-mode canvas path) that call it with one
 * argument. That is what "exports stay unchanged" comes down to at the
 * function level: every value below is the literal hex the tables define.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFillColorForType, IFC_TYPE_FILL_COLORS, IFC_TYPE_FILL_COLORS_DARK } from './ifc-fill-colors.js';

describe('getFillColorForType (#5496)', () => {
  it('defaults to the light drafting palette when dark is omitted', () => {
    assert.equal(getFillColorForType('IfcWall'), '#b0b0b0');
    assert.equal(getFillColorForType('IfcWall'), IFC_TYPE_FILL_COLORS.IfcWall);
  });

  it('an unknown type falls back to the light default when dark is omitted', () => {
    assert.equal(getFillColorForType('IfcNoSuchType'), IFC_TYPE_FILL_COLORS.default);
  });

  it('dark=true reads the dark-paper table instead, for the same type', () => {
    assert.equal(getFillColorForType('IfcWall', true), IFC_TYPE_FILL_COLORS_DARK.IfcWall);
    assert.notEqual(getFillColorForType('IfcWall', true), getFillColorForType('IfcWall', false));
  });

  it('dark=true still falls back to ITS OWN default for an unknown type, not the light one', () => {
    assert.equal(getFillColorForType('IfcNoSuchType', true), IFC_TYPE_FILL_COLORS_DARK.default);
    assert.notEqual(IFC_TYPE_FILL_COLORS_DARK.default, IFC_TYPE_FILL_COLORS.default);
  });

  it('every light-palette key has a dark-paper analogue, so no type silently loses its dark styling', () => {
    for (const key of Object.keys(IFC_TYPE_FILL_COLORS)) {
      assert.ok(key in IFC_TYPE_FILL_COLORS_DARK, `IFC_TYPE_FILL_COLORS_DARK is missing "${key}"`);
    }
  });
});
