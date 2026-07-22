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
 *
 * Since #1799 rejection is by token KIND (the extractor's `enumAttrIndices`
 * side channel), not by dotted-string shape: a QUOTED string that merely looks
 * like an enum (`'.USERDEFINED.'`) survives, exactly matching the Rust path's
 * `AttributeValue::String` / `AttributeValue::Enum` split.
 */

import { describe, it, expect } from 'vitest';
import { extractRootAttributesFromEntity } from '../src/columnar-parser.js';
import { getAttributeNames } from '../src/ifc-schema.js';
import { EntityExtractor } from '../src/entity-extractor.js';
import type { IfcEntity } from '@ifc-lite/data';

/** Run a single STEP record through the real extractor (the kind-channel producer). */
function extract(record: string, expressId: number, type: string): IfcEntity {
  const buffer = new TextEncoder().encode(record);
  const entity = new EntityExtractor(buffer).extractEntity({
    expressId,
    type,
    byteOffset: 0,
    byteLength: buffer.length,
    lineNumber: 1,
  });
  if (!entity) throw new Error(`extractEntity failed for: ${record}`);
  return entity;
}

describe('extractRootAttributesFromEntity — enum fallback (#1779, #1799)', () => {
  it('IfcAlignment is unknown to the pinned registry (premise of the fallback tests)', () => {
    // If a future registry pin adds IfcAlignment, the fallback tests below would
    // silently stop exercising the unknown-type path — pin the premise here.
    expect(getAttributeNames('IfcAlignment')).toHaveLength(0);
  });

  it('drops a bare enum token at a fallback index instead of leaking it as Tag', () => {
    // IfcAlignment is unknown to the IFC4 registry → fixed-index fallback.
    // attrs: [GlobalId, OwnerHistory, Name, Description, ObjectType, ..., PredefinedType@7]
    const entity = extract(
      "#1=IFCALIGNMENT('0GUID',$,'Main Alignment','centre line','objtype',$,$,.USERDEFINED.)",
      1,
      'IFCALIGNMENT'
    );
    // The extractor flagged the bare token's KIND without changing its value.
    expect(entity.attributes[7]).toBe('.USERDEFINED.');
    expect(entity.enumAttrIndices).toEqual([7]);
    const attrs = extractRootAttributesFromEntity(entity);
    expect(attrs.tag).toBe(''); // was '.USERDEFINED.'
    // Genuine (non-enum) string attributes still resolve on the fallback path.
    expect(attrs.name).toBe('Main Alignment');
    expect(attrs.description).toBe('centre line');
    expect(attrs.objectType).toBe('objtype');
  });

  it('keeps a QUOTED enum-shaped string at a fallback index (kind beats shape, #1799)', () => {
    // Same record, but the source token is a quoted STRING '.USERDEFINED.' —
    // the Rust server path keeps it (AttributeValue::String), and since #1799
    // the client does too. Under the #1779 shape heuristic this was blanked.
    const entity = extract(
      "#1=IFCALIGNMENT('0GUID',$,'Main Alignment',$,$,$,$,'.USERDEFINED.')",
      1,
      'IFCALIGNMENT'
    );
    expect(entity.attributes[7]).toBe('.USERDEFINED.'); // value identical to the bare case…
    expect(entity.enumAttrIndices).toBeUndefined(); // …but the kind channel says String
    expect(extractRootAttributesFromEntity(entity).tag).toBe('.USERDEFINED.');
  });

  it('leaves a genuine string Tag untouched on the fallback path', () => {
    const entity = extract("#2=IFCALIGNMENT('0GUID',$,'A',$,$,$,$,'TAG-123')", 2, 'IFCALIGNMENT');
    expect(entity.enumAttrIndices).toBeUndefined();
    expect(extractRootAttributesFromEntity(entity).tag).toBe('TAG-123');
  });

  it('does not touch known types (schema index → genuine Tag slot)', () => {
    // IfcWall attr 7 is Tag by schema; a normal string tag is unaffected.
    const entity = extract("#3=IFCWALL('0GUID',$,'W-1',$,$,$,$,'wall-tag',.SOLIDWALL.)", 3, 'IFCWALL');
    expect(entity.enumAttrIndices).toEqual([8]); // PredefinedType flagged, Tag not
    expect(extractRootAttributesFromEntity(entity).tag).toBe('wall-tag');
  });

  it('does not blank an enum-flagged slot on a KNOWN type (filter is unknown-only)', () => {
    // Scoping proof: even a bare enum token at attr 7 survives on a known type,
    // because the schema index resolves the real slot and the filter is gated
    // on !idx.known. (A genuine IfcWall Tag would never be an enum, but this
    // pins that the filter can't reach the known-type path.)
    const entity: IfcEntity = {
      expressId: 4,
      type: 'IfcWall',
      attributes: ['0GUID', null, 'W-2', null, null, null, null, '.USERDEFINED.'],
      enumAttrIndices: [7],
    };
    expect(extractRootAttributesFromEntity(entity).tag).toBe('.USERDEFINED.');
  });

  it('tolerates entities without the kind channel (hand-built / legacy producers)', () => {
    // No enumAttrIndices → nothing is enum-kind → the string survives, which is
    // exactly what the server does for a genuine string value.
    const entity: IfcEntity = {
      expressId: 5,
      type: 'IfcAlignment',
      attributes: ['0GUID', null, 'A', null, null, null, null, '.USERDEFINED.'],
    };
    expect(extractRootAttributesFromEntity(entity).tag).toBe('.USERDEFINED.');
  });
});

describe('EntityExtractor enumAttrIndices side channel (#1799)', () => {
  it('flags bare enums at any top-level position, mirroring the Rust tokenizer rule', () => {
    const entity = extract("#10=IFCTHING(.T.,'a',.FLAT_ROOF.,$,42,.b2_x.)", 10, 'IFCTHING');
    // Values keep the historical representation (dotted strings)…
    expect(entity.attributes).toEqual(['.T.', 'a', '.FLAT_ROOF.', null, 42, '.b2_x.']);
    // …and the channel records the kind, including mid-list and tail positions.
    // `.b2_x.` matches the Rust enum_value rule ('.' [A-Za-z0-9_]+ '.').
    expect(entity.enumAttrIndices).toEqual([0, 2, 5]);
  });

  it('does not flag nested enums (inside lists or typed values) or non-enum tokens', () => {
    const entity = extract(
      "#11=IFCTHING((.A.,.B.),IFCBOOLEAN(.T.),'.QUOTED.',#5,*,.NOT AN ENUM.)",
      11,
      'IFCTHING'
    );
    // list + typed value keep their nested representation, unflagged
    expect(entity.attributes[0]).toEqual(['.A.', '.B.']);
    expect(entity.attributes[1]).toEqual(['IFCBOOLEAN', '.T.']);
    // quoted string, reference, derived (*), and a dotted token with a space
    // (which the Rust tokenizer would not lex as an enum) are all non-enum-kind
    expect(entity.enumAttrIndices).toBeUndefined();
  });
});
