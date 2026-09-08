/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3789 follow-up: `getStepAttr`'s record regex (private to this module)
 * required its type name immediately adjacent to '(' -- unlike
 * `entity-extractor.ts`'s sibling fix. Asserted through the public
 * `resolveContextWcsMetres`: when the context's own STEP line, or the
 * `IfcCartesianPoint` / `IfcDirection` it points at, is wrapped or carries a
 * comment before its args paren, the resolved WCS silently comes back null
 * instead of the real frame. Per this module's own doc, a null WCS is
 * treated PERMISSIVELY ("compatible") by every caller, so an unreadable
 * frame can mask a real origin mismatch between two models being merged --
 * the wrong-place bug class this module exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import { resolveContextWcsMetres } from './merged-context.js';
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

// `IfcGeometricRepresentationContext` attribute layout (0-based): [0]
// ContextIdentifier, [1] ContextType, [2] CoordinateSpaceDimension, [3]
// Precision, [4] WorldCoordinateSystem (an IfcCartesianPoint here, the
// no-placement-wrapper shape this module's own tests use).
function fixture(contextLine: string): MockDataStore {
  return buildStore([
    [1, 'IFCCARTESIANPOINT', `#1=IFCCARTESIANPOINT((0.,0.,0.));`],
    [2, 'IFCGEOMETRICREPRESENTATIONCONTEXT', contextLine],
  ]);
}

describe('resolveContextWcsMetres: trivia between the type name and "(" (#3789)', () => {
  it('resolves a WCS when the context record is wrapped across a CRLF', () => {
    const store = fixture(`#2=IFCGEOMETRICREPRESENTATIONCONTEXT\r\n($,'Model',3,1.E-05,#1,$);`);
    const wcs = resolveContextWcsMetres(store, 2, 1);
    expect(wcs).not.toBeNull();
    expect(wcs!.x).toBe(0);
  });

  it('resolves a WCS when the context record carries a comment before "("', () => {
    const store = fixture(`#2=IFCGEOMETRICREPRESENTATIONCONTEXT/* c */($,'Model',3,1.E-05,#1,$);`);
    const wcs = resolveContextWcsMetres(store, 2, 1);
    expect(wcs).not.toBeNull();
    expect(wcs!.x).toBe(0);
  });

  it('a comment containing "(" or ";" does not derail the parse (control)', () => {
    const store = fixture(`#2=IFCGEOMETRICREPRESENTATIONCONTEXT/* has ( and ; inside */($,'Model',3,1.E-05,#1,$);`);
    const wcs = resolveContextWcsMetres(store, 2, 1);
    expect(wcs).not.toBeNull();
  });

  it('still resolves an adjacent context correctly (no regression)', () => {
    const store = fixture(`#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#1,$);`);
    const wcs = resolveContextWcsMetres(store, 2, 1);
    expect(wcs).not.toBeNull();
    expect(wcs!.x).toBe(0);
    expect(wcs!.y).toBe(0);
    expect(wcs!.z).toBe(0);
  });
});
