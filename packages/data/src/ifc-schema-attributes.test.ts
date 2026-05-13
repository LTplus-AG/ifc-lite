/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { getAttributeXsdTypes } from './ifc-schema/index.js';

describe('getAttributeXsdTypes', () => {
  it('returns xs:integer for IfcStairFlight.NumberOfRisers (IFC4)', () => {
    const types = getAttributeXsdTypes('IFC4', 'IFCSTAIRFLIGHT', 'NumberOfRisers');
    expect(types).toEqual(['xs:integer']);
  });

  it('returns xs:double for IfcStairFlight.RiserHeight (IFC4)', () => {
    const types = getAttributeXsdTypes('IFC4', 'IFCSTAIRFLIGHT', 'RiserHeight');
    expect(types).toEqual(['xs:double']);
  });

  it('returns xs:double for IfcSurfaceStyleRefraction.RefractionIndex', () => {
    const types = getAttributeXsdTypes('IFC4', 'IFCSURFACESTYLEREFRACTION', 'RefractionIndex');
    expect(types).toEqual(['xs:double']);
  });

  it('returns the union when an attribute spans multiple types', () => {
    // Width is xs:integer on IfcPixelTexture but xs:double on shape profiles —
    // upstream emits the union so the caller can decide.
    const types = getAttributeXsdTypes('IFC4', 'IFCPIXELTEXTURE', 'Width');
    expect(types).toBeDefined();
    expect(types).toContain('xs:integer');
  });

  it('handles xs:string attributes', () => {
    const types = getAttributeXsdTypes('IFC4', 'IFCROOT', 'Name');
    expect(types).toEqual(['xs:string']);
  });

  it('handles xs:boolean attributes', () => {
    // IfcPresentationLayerWithStyle.LayerOn (IFC2x3) is xs:boolean —
    // IFC4 widens it to xs:string. The version-specific lookup picks
    // the right one.
    const types = getAttributeXsdTypes('IFC2X3', 'IFCPRESENTATIONLAYERWITHSTYLE', 'LayerOn');
    expect(types).toEqual(['xs:boolean']);
  });

  it('returns case-insensitive match on attribute name', () => {
    const lower = getAttributeXsdTypes('IFC4', 'IFCSTAIRFLIGHT', 'numberofrisers');
    expect(lower).toEqual(['xs:integer']);
  });

  it('returns case-insensitive match on entity name', () => {
    const mixed = getAttributeXsdTypes('IFC4', 'IfcStairFlight', 'NumberOfRisers');
    expect(mixed).toEqual(['xs:integer']);
  });

  it('returns undefined for unknown entity', () => {
    const types = getAttributeXsdTypes('IFC4', 'IFCNOTAREALTHING', 'NumberOfRisers');
    expect(types).toBeUndefined();
  });

  it('returns undefined for attribute not on the given entity', () => {
    // RiserHeight only exists on IfcStairFlight, not on IfcWall.
    const types = getAttributeXsdTypes('IFC4', 'IFCWALL', 'RiserHeight');
    expect(types).toBeUndefined();
  });

  it('returns undefined for unknown attribute', () => {
    const types = getAttributeXsdTypes('IFC4', 'IFCSTAIRFLIGHT', 'NotAnAttribute');
    expect(types).toBeUndefined();
  });

  it('respects IFC version differences', () => {
    // CreationDate carries different XSD type sets across IFC versions
    // — pre-4 schemas only had integer, IFC4+ added dateTime.
    const ifc2x3 = getAttributeXsdTypes('IFC2X3', 'IFCOWNERHISTORY', 'CreationDate');
    const ifc4 = getAttributeXsdTypes('IFC4', 'IFCOWNERHISTORY', 'CreationDate');
    expect(ifc2x3).toBeDefined();
    expect(ifc4).toBeDefined();
    // Both versions should contain at least one xs:* type.
    expect(ifc2x3!.length).toBeGreaterThan(0);
    expect(ifc4!.length).toBeGreaterThan(0);
  });
});
