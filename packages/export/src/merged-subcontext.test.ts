/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3789 follow-up: `getStepAttr`'s record regex (private to this module)
 * required its type name immediately adjacent to '(' -- unlike
 * `entity-extractor.ts`'s sibling fix. Asserted through the public
 * `groupSubContextsByKey`: when a subcontext's own STEP line is wrapped or
 * carries a comment before its args paren, every attribute read through
 * `getStepAttr` (ContextIdentifier, TargetView) came back null, so the
 * subcontext's key degraded to the same unreadable-placeholder bucket
 * regardless of its real kind -- exactly the positional-match failure mode
 * `planSubContextUnify` exists to prevent (a Body subcontext unified onto an
 * Axis one).
 */

import { describe, it, expect } from 'vitest';
import { groupSubContextsByKey } from './merged-subcontext.js';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';

type MockEntityRef = { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number };
type MockDataStore = Omit<IfcDataStore, 'entityIndex'> & {
  entityIndex: { byId: Map<number, MockEntityRef>; byType: Map<string, number[]> };
};

/** Build a minimal IfcDataStore from `[expressId, type, stepText]` lines. */
function buildStore(entries: Array<[number, string, string]>): MockDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  for (const [expressId, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(expressId, { expressId, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(expressId);
    parts.push(encoded);
    offset += encoded.byteLength;
  }
  const source = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    source.set(part, pos);
    pos += part.byteLength;
  }
  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as MockDataStore;
}

// `IfcGeometricRepresentationSubContext` attribute layout (0-based):
// ContextIdentifier(0), ContextType(1), CoordinateSpaceDimension(2),
// Precision(3), WorldCoordinateSystem(4), TrueNorth(5), ParentContext(6),
// TargetScale(7), TargetView(8), UserDefinedTargetView(9).
const BODY = "'Body','Model',3,$,#1,$,#2,$,.MODEL_VIEW.,$";
const AXIS = "'Axis','Model',3,$,#1,$,#2,$,.MODEL_VIEW.,$";

describe('groupSubContextsByKey: trivia between the type name and "(" (#3789)', () => {
  it('groups a Body and an Axis subcontext into distinct buckets when both records are wrapped across a CRLF', () => {
    // If `getStepAttr` cannot read EITHER record, both degrade to the same
    // "unreadable" key and collapse into one bucket -- the exact
    // positional-match failure `planSubContextUnify` exists to prevent (a
    // Body subcontext unified onto an Axis one, per this module's own doc).
    const store = buildStore([
      [10, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#10=IFCGEOMETRICREPRESENTATIONSUBCONTEXT\r\n(${BODY});`],
      [11, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT\r\n(${AXIS});`],
    ]);
    const groups = groupSubContextsByKey(store, [10, 11]);
    expect(groups.size).toBe(2);
    for (const ids of groups.values()) {
      expect(ids.length).toBe(1);
    }
  });

  it('groups a Body and an Axis subcontext into distinct buckets when both records carry a comment before "("', () => {
    const store = buildStore([
      [10, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#10=IFCGEOMETRICREPRESENTATIONSUBCONTEXT/* c */(${BODY});`],
      [11, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT/* c */(${AXIS});`],
    ]);
    const groups = groupSubContextsByKey(store, [10, 11]);
    expect(groups.size).toBe(2);
    for (const ids of groups.values()) {
      expect(ids.length).toBe(1);
    }
  });

  // A trailing `X` would NOT test this: `\w+` simply absorbs it into the type
  // name, leaving the record readable and the two keys distinct -- the test
  // would pass for the opposite reason to the one it claims. `#5` cannot be
  // part of `\w+` and is not STEP trivia, so RECORD_RE genuinely fails to
  // match and `getStepAttr` returns null for both records.
  it('two-way rule: non-whitespace, non-comment junk before "(" still reads as unreadable (both fall in the same empty-key bucket)', () => {
    const store = buildStore([
      [10, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#10=IFCGEOMETRICREPRESENTATIONSUBCONTEXT#5(${BODY});`],
      [11, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT#5(${AXIS});`],
    ]);
    const groups = groupSubContextsByKey(store, [10, 11]);
    // Unreadable on BOTH records, so both collapse to the same empty key --
    // the widened trivia rule did not quietly start accepting arbitrary
    // separators.
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toEqual([10, 11]);
  });

  it('groups two subcontexts of the same real kind into one bucket (no regression)', () => {
    const store = buildStore([
      [10, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#10=IFCGEOMETRICREPRESENTATIONSUBCONTEXT(${BODY});`],
      [11, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', `#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT(${BODY});`],
    ]);
    const groups = groupSubContextsByKey(store, [10, 11]);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toEqual([10, 11]);
  });
});
