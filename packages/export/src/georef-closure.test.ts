/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { collectReferencedEntityIds } from './reference-collector.js';
import { collectGeoreferencingEntities } from './georef-closure.js';

/**
 * Helper: encode a set of STEP entity lines into a source buffer + entity
 * index. Same shape as `reference-collector.test.ts`'s own `buildTestData` —
 * duplicated rather than imported/exported across the two test files, which
 * would couple two independent test suites for a ~15-line helper.
 */
function buildTestData(
  entries: Array<[number, string, string]>,
): { source: Uint8Array; entityIndex: Map<number, { type: string; byteOffset: number; byteLength: number }> } {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const entityIndex = new Map<number, { type: string; byteOffset: number; byteLength: number }>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    entityIndex.set(id, { type, byteOffset: offset, byteLength: encoded.byteLength });
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    source.set(part, pos);
    pos += part.byteLength;
  }

  return { source, entityIndex };
}

describe('collectGeoreferencingEntities', () => {
  /**
   * Build a byId/byType entity index (the shape `collectGeoreferencingEntities`
   * and `collectStyleEntities` both take) from `buildTestData`'s entries.
   */
  function buildIndex(entries: Array<[number, string, string]>) {
    const { source, entityIndex } = buildTestData(entries);
    const byType = new Map<string, number[]>();
    for (const [id, type] of entries) {
      const list = byType.get(type);
      if (list) list.push(id);
      else byType.set(type, [id]);
    }
    return { source, byId: entityIndex, byType };
  }

  it('rescues IFCMAPCONVERSION + IFCPROJECTEDCRS the forward closure cannot reach', () => {
    // #1 IFCPROJECT references only the context (#2), never the map
    // conversion — mirrors a real file, where IfcMapConversion.SourceCRS (#3
    // -> #2) points AT the context and nothing points the other way.
    const entries: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Proj',$,$,$,$,(#2),$);"],
      [2, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);"],
      [4, 'IFCAXIS2PLACEMENT3D', '#4=IFCAXIS2PLACEMENT3D(#6,$,$);'],
      [6, 'IFCCARTESIANPOINT', '#6=IFCCARTESIANPOINT((0.,0.,0.));'],
      [3, 'IFCMAPCONVERSION', '#3=IFCMAPCONVERSION(#2,#5,160000.,450000.,0.,$,$,$);'],
      [5, 'IFCPROJECTEDCRS', "#5=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);

    // The ordinary forward closure from the project (the shape every real
    // export root set produces): IFCPROJECT -> context -> its axis
    // placement -> its point. IfcMapConversion is unreachable.
    const closure = collectReferencedEntityIds(new Set([1]), source, byId);
    expect(closure.has(2)).toBe(true);  // context is in the closure
    expect(closure.has(3)).toBe(false); // RED: IfcMapConversion dropped
    expect(closure.has(5)).toBe(false); // RED: IfcProjectedCRS dropped

    collectGeoreferencingEntities(closure, source, { byId, byType });

    expect(closure.has(3)).toBe(true);  // IfcMapConversion rescued
    expect(closure.has(5)).toBe(true);  // its IfcProjectedCRS (TargetCRS) too
  });

  it('does not rescue IFCMAPCONVERSION when its context was itself excluded', () => {
    // A closure that never reached the context (e.g. hypothetically excluded)
    // must not pull the map conversion in either — it only rescues entities
    // whose SourceCRS is ALREADY in the closure.
    const entries: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Proj',$,$,$,$,$,$);"],
      [2, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);"],
      [3, 'IFCMAPCONVERSION', '#3=IFCMAPCONVERSION(#2,#5,160000.,450000.,0.,$,$,$);'],
      [5, 'IFCPROJECTEDCRS', "#5=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);

    const closure = new Set<number>([1]); // context (#2) never entered the closure
    collectGeoreferencingEntities(closure, source, { byId, byType });

    expect(closure.has(3)).toBe(false);
    expect(closure.has(5)).toBe(false);
  });

  it('does not rescue IFCMAPCONVERSION when only its TargetCRS (not its SourceCRS context) is in the closure', () => {
    // https://github.com/LTplus-AG/ifc-lite/pull/3696 review thread
    // (georef-closure.ts:83): the rescue condition checked "any referenced
    // id", not specifically SourceCRS. A subset closure that happens to
    // already contain IFCPROJECTEDCRS #5 (e.g. reused by an unrelated
    // survived entity) but never reached the context #2 must not resurrect
    // IFCMAPCONVERSION #3 on that basis — and must not then walk #3 forward
    // into pulling #2 in too.
    const entries: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Proj',$,$,$,$,$,$);"],
      [2, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);"],
      [3, 'IFCMAPCONVERSION', '#3=IFCMAPCONVERSION(#2,#5,160000.,450000.,0.,$,$,$);'],
      [5, 'IFCPROJECTEDCRS', "#5=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);

    const closure = new Set<number>([5]); // TargetCRS present, SourceCRS context (#2) absent
    collectGeoreferencingEntities(closure, source, { byId, byType });

    expect(closure.has(3)).toBe(false); // must not rescue on TargetCRS alone
    expect(closure.has(2)).toBe(false); // and must not then pull the context in via #3
  });

  it('is a no-op when the file has no IFCMAPCONVERSION', () => {
    const entries: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Proj',$,$,$,$,$,$);"],
      [2, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);
    const closure = new Set<number>([1, 2]);
    const before = new Set(closure);

    collectGeoreferencingEntities(closure, source, { byId, byType });

    expect(closure).toEqual(before);
  });

  it('honours excludeIds — a deliberately-scrubbed IFCMAPCONVERSION is never resurrected', () => {
    // Mirrors `subset-roots.ts`'s "remove georeferencing" option: the caller
    // has already routed #3/#5 into an exclusion set (privacy scrub), and
    // this reverse pass's only hook (the context, #2) is unconditional
    // infrastructure that stays in the closure regardless — it must not use
    // that hook to bring the excluded ids back.
    const entries: Array<[number, string, string]> = [
      [1, 'IFCPROJECT', "#1=IFCPROJECT('g',$,'Proj',$,$,$,$,(#2),$);"],
      [2, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,$,$);"],
      [3, 'IFCMAPCONVERSION', '#3=IFCMAPCONVERSION(#2,#5,160000.,450000.,0.,$,$,$);'],
      [5, 'IFCPROJECTEDCRS', "#5=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);
    const closure = new Set<number>([1, 2]);
    const excludeIds = new Set<number>([3, 5]);

    collectGeoreferencingEntities(closure, source, { byId, byType }, excludeIds);

    expect(closure.has(3)).toBe(false);
    expect(closure.has(5)).toBe(false);
  });
});
