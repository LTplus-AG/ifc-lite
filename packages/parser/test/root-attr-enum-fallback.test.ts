/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unknown-type root-attribute fallback must not leak STEP bare-enum tokens into
 * string display attributes (#1779). For a type absent from the schema registry
 * (e.g. IFC4X3 IfcAlignment), the fixed-index fallback can land on a
 * PredefinedType enum at attr 7; the extractor stores it as a dotted string
 * (`.USERDEFINED.`), which used to surface as `Tag`. The Rust server path
 * rejects enums, so the client must render blank too.
 */

import { describe, it, expect } from 'vitest';
import { extractRootAttributesFromEntity } from '../src/columnar-parser.js';
import { getAttributeNames } from '../src/ifc-schema.js';
import type { IfcEntity } from '@ifc-lite/data';

describe('extractRootAttributesFromEntity — enum fallback (#1779)', () => {
  it('IfcAlignment is unknown to the pinned registry (premise of the fallback tests)', () => {
    // If a future registry pin adds IfcAlignment, the fallback tests below would
    // silently stop exercising the unknown-type path — pin the premise here.
    expect(getAttributeNames('IfcAlignment')).toHaveLength(0);
  });

  it('drops a dotted enum token at a fallback index instead of leaking it as Tag', () => {
    // IfcAlignment is unknown to the IFC4 registry → fixed-index fallback.
    // attrs: [GlobalId, OwnerHistory, Name, Description, ObjectType, ..., PredefinedType@7]
    const entity: IfcEntity = {
      expressId: 1,
      type: 'IfcAlignment',
      attributes: ['0GUID', null, 'Main Alignment', 'centre line', 'objtype', null, null, '.USERDEFINED.'],
    };
    const attrs = extractRootAttributesFromEntity(entity);
    expect(attrs.tag).toBe(''); // was '.USERDEFINED.'
    // Genuine (non-enum) string attributes still resolve on the fallback path.
    expect(attrs.name).toBe('Main Alignment');
    expect(attrs.description).toBe('centre line');
    expect(attrs.objectType).toBe('objtype');
  });

  it('leaves a genuine string Tag untouched on the fallback path', () => {
    const entity: IfcEntity = {
      expressId: 2,
      type: 'IfcAlignment',
      attributes: ['0GUID', null, 'A', null, null, null, null, 'TAG-123'],
    };
    expect(extractRootAttributesFromEntity(entity).tag).toBe('TAG-123');
  });

  it('does not touch known types (schema index → genuine Tag slot)', () => {
    // IfcWall attr 7 is Tag by schema; a normal string tag is unaffected.
    const entity: IfcEntity = {
      expressId: 3,
      type: 'IfcWall',
      attributes: ['0GUID', null, 'W-1', null, null, null, null, 'wall-tag'],
    };
    expect(extractRootAttributesFromEntity(entity).tag).toBe('wall-tag');
  });

  it('does not blank a dotted token on a KNOWN type (filter is unknown-only)', () => {
    // Scoping proof: even a value shaped like an enum survives on a known type,
    // because the schema index resolves the real slot and the filter is gated
    // on !idx.known. (A genuine IfcWall Tag would never be an enum, but this
    // pins that the filter can't reach the known-type path.)
    const entity: IfcEntity = {
      expressId: 4,
      type: 'IfcWall',
      attributes: ['0GUID', null, 'W-2', null, null, null, null, '.USERDEFINED.'],
    };
    expect(extractRootAttributesFromEntity(entity).tag).toBe('.USERDEFINED.');
  });
});
