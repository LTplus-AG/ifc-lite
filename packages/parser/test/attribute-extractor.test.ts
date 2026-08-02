/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for on-demand attribute extraction
 */

import { describe, it, expect } from 'vitest';
import { extractEntityAttributesOnDemand } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

describe('Entity Attribute Extraction', () => {
  it('should extract GlobalId, Name, Description, and ObjectType from IFC entity', () => {
    // Create a minimal IFC entity in STEP format
    // IfcWall: #123 = IFCWALL('0hqLFcvYZB4I_n8fG2dLb3', #1, 'My Wall Name', 'Wall Description', 'Wall Type', ...)
    const ifcEntity = `#123=IFCWALL('0hqLFcvYZB4I_n8fG2dLb3',#1,'My Wall Name','Wall Description','Wall Type',#2,#3,.NOTDEFINED.);`;
    const source = new TextEncoder().encode(ifcEntity);

    // Create minimal store with necessary structures
    const entityRef: EntityRef = {
      expressId: 123,
      type: 'IfcWall',
      byteOffset: 0,
      byteLength: source.length,
      lineNumber: 1,
    };

    const store = {
      source,
      entityIndex: {
        byId: new Map([[123, entityRef]]),
        byType: new Map([['IFCWALL', [123]]]),
      },
    } as unknown as IfcDataStore;

    const attrs = extractEntityAttributesOnDemand(store, 123);

    expect(attrs.globalId).toBe('0hqLFcvYZB4I_n8fG2dLb3');
    expect(attrs.name).toBe('My Wall Name');
    expect(attrs.description).toBe('Wall Description');
    expect(attrs.objectType).toBe('Wall Type');
  });

  it('should return empty strings for missing attributes', () => {
    // IFC entity with $  for missing values
    const ifcEntity = `#456=IFCBEAM('abc123',$,$,$,$,$,$,.NOTDEFINED.);`;
    const source = new TextEncoder().encode(ifcEntity);

    const entityRef: EntityRef = {
      expressId: 456,
      type: 'IfcBeam',
      byteOffset: 0,
      byteLength: source.length,
      lineNumber: 1,
    };

    const store = {
      source,
      entityIndex: {
        byId: new Map([[456, entityRef]]),
        byType: new Map([['IFCBEAM', [456]]]),
      },
    } as unknown as IfcDataStore;

    const attrs = extractEntityAttributesOnDemand(store, 456);

    expect(attrs.globalId).toBe('abc123');
    expect(attrs.name).toBe('');
    expect(attrs.description).toBe('');
    expect(attrs.objectType).toBe('');
  });

  it('should decode IFC encoded special characters (umlauts, etc.)', () => {
    // Name contains \X2\00FC\X0\ which should decode to ü
    const ifcEntity = `#789=IFCWALL('globalId1',#1,'Modelleinf\\X2\\00FC\\X0\\gepunkt','Br\\X2\\00FC\\X0\\cke \\X2\\00E4\\X0\\','Type \\X2\\00F6\\X0\\',#2,#3,.NOTDEFINED.);`;
    const source = new TextEncoder().encode(ifcEntity);

    const entityRef: EntityRef = {
      expressId: 789,
      type: 'IfcWall',
      byteOffset: 0,
      byteLength: source.length,
      lineNumber: 1,
    };

    const store = {
      source,
      entityIndex: {
        byId: new Map([[789, entityRef]]),
        byType: new Map([['IFCWALL', [789]]]),
      },
    } as unknown as IfcDataStore;

    const attrs = extractEntityAttributesOnDemand(store, 789);

    expect(attrs.name).toBe('Modelleinfügepunkt');
    expect(attrs.description).toBe('Brücke ä');
    expect(attrs.objectType).toBe('Type ö');
  });

  it('should decode \\S\\ extended ASCII encoding', () => {
    // \S\D should decode to Ä (D=68, 68+128=196=0xC4=Ä in ISO-8859-1)
    const ifcEntity = `#790=IFCWALL('globalId2',#1,'\\S\\Dpfel','','',$,$,.NOTDEFINED.);`;
    const source = new TextEncoder().encode(ifcEntity);

    const entityRef: EntityRef = {
      expressId: 790,
      type: 'IfcWall',
      byteOffset: 0,
      byteLength: source.length,
      lineNumber: 1,
    };

    const store = {
      source,
      entityIndex: {
        byId: new Map([[790, entityRef]]),
        byType: new Map([['IFCWALL', [790]]]),
      },
    } as unknown as IfcDataStore;

    const attrs = extractEntityAttributesOnDemand(store, 790);

    expect(attrs.name).toBe('Äpfel');
  });

  it('should handle entity not found', () => {
    const store = {
      source: new Uint8Array(0),
      entityIndex: {
        byId: new Map(),
        byType: new Map(),
      },
    } as unknown as IfcDataStore;

    const attrs = extractEntityAttributesOnDemand(store, 999);

    expect(attrs.globalId).toBe('');
    expect(attrs.name).toBe('');
    expect(attrs.description).toBe('');
    expect(attrs.objectType).toBe('');
  });

  // ── Schema-mapped (non-IfcElement) layouts ──────────────────────
  // The fixed indices [0],[2],[3],[4],[7] only hold for IfcElement. These
  // assert the attributes are resolved by schema name so other layouts stay
  // correct (regression guard for the positional-index extraction).

  function storeFor(step: string, expressId: number): IfcDataStore {
    const source = new TextEncoder().encode(step);
    const ref: EntityRef = {
      expressId,
      type: step.match(/=\s*(\w+)/)![1],
      byteOffset: 0,
      byteLength: source.length,
      lineNumber: 1,
    };
    return {
      source,
      entityIndex: { byId: new Map([[expressId, ref]]), byType: new Map() },
    } as unknown as IfcDataStore;
  }

  it('does not surface a spatial element LongName as Tag (IfcSite)', () => {
    // IfcSite has no Tag attribute; `attrs[7]` is LongName. The IfcElement
    // positional layout would wrongly report LongName as the entity Tag.
    const step = `#1=IFCSITE('site-guid',$,'Site Name','Site Desc','SiteObjType',$,$,'My Long Name',.ELEMENT.,$,$,$,$,$);`;
    const attrs = extractEntityAttributesOnDemand(storeFor(step, 1), 1);

    expect(attrs.globalId).toBe('site-guid');
    expect(attrs.name).toBe('Site Name');
    expect(attrs.description).toBe('Site Desc');
    expect(attrs.objectType).toBe('SiteObjType');
    expect(attrs.tag).toBe(''); // not 'My Long Name'
  });

  it('reads resource-entity attributes by name (IfcMaterial)', () => {
    // IfcMaterial attribute order is [Name, Description, Category] — it has no
    // GlobalId, so `attrs[0]` is the material Name, not a GlobalId.
    const step = `#2=IFCMATERIAL('Concrete','Cast in place','concrete');`;
    const attrs = extractEntityAttributesOnDemand(storeFor(step, 2), 2);

    expect(attrs.globalId).toBe(''); // not 'Concrete'
    expect(attrs.name).toBe('Concrete'); // not 'concrete'
    expect(attrs.description).toBe('Cast in place');
    expect(attrs.objectType).toBe('');
    expect(attrs.tag).toBe('');
  });

  it('falls back to the IfcElement layout for schema-unknown types', () => {
    // Unknown/vendor types aren't in the registry; preserve the legacy
    // positional behaviour rather than returning empty strings.
    const step = `#3=IFCFOOBARXYZ('foo-guid',$,'Foo Name','Foo Desc','Foo Type',$,$,'Foo Tag');`;
    const attrs = extractEntityAttributesOnDemand(storeFor(step, 3), 3);

    expect(attrs.globalId).toBe('foo-guid');
    expect(attrs.name).toBe('Foo Name');
    expect(attrs.description).toBe('Foo Desc');
    expect(attrs.objectType).toBe('Foo Type');
    expect(attrs.tag).toBe('Foo Tag');
  });
});
