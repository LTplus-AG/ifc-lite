/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  PRODUCT_TYPES,
  collectReferencedEntityIds,
  getVisibleEntityIds,
  filterHiddenRefsFromRelationshipLine,
} from './reference-collector.js';
import { collectStyleEntities } from './style-closure.js';
import { EMPTY_SOURCE_BYTES, type IfcDataStore } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import {
  ENTITIES_IFC2X3,
  ENTITIES_IFC4,
  ENTITIES_IFC4X3,
  type IfcEntityInfo,
} from '@ifc-lite/data';

/**
 * Helper: encode a set of STEP entity lines into a source buffer + entity index.
 * Each entry is [expressId, type, stepText].
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

  // Concatenate all parts
  const source = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    source.set(part, pos);
    pos += part.byteLength;
  }

  return { source, entityIndex };
}

describe('collectReferencedEntityIds', () => {
  it('should collect direct references from a root entity', () => {
    const { source, entityIndex } = buildTestData([
      [1, 'IFCWALL', "#1=IFCWALL('guid',#2,'Wall',$,#3,#4,$,$);"],
      [2, 'IFCOWNERHISTORY', "#2=IFCOWNERHISTORY(#5,$,$,$);"],
      [3, 'IFCLOCALPLACEMENT', "#3=IFCLOCALPLACEMENT($,#6);"],
      [4, 'IFCPRODUCTDEFINITIONSHAPE', "#4=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));"],
      [5, 'IFCPERSONANDORGANIZATION', "#5=IFCPERSONANDORGANIZATION(#8,#9);"],
      [6, 'IFCAXIS2PLACEMENT3D', "#6=IFCAXIS2PLACEMENT3D(#10,$,$);"],
      [7, 'IFCSHAPEREPRESENTATION', "#7=IFCSHAPEREPRESENTATION(#11,'Body','Brep',(#12));"],
      [8, 'IFCPERSON', "#8=IFCPERSON($,'Author',$,$,$,$,$,$);"],
      [9, 'IFCORGANIZATION', "#9=IFCORGANIZATION($,'Org',$,$,$);"],
      [10, 'IFCCARTESIANPOINT', '#10=IFCCARTESIANPOINT((0.,0.,0.));'],
      [11, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', "#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#13,$,.MODEL_VIEW.,$);"],
      [12, 'IFCEXTRUDEDAREASOLID', '#12=IFCEXTRUDEDAREASOLID(#14,#15,#16,2.5);'],
      [13, 'IFCGEOMETRICREPRESENTATIONCONTEXT', "#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#17,$);"],
      [14, 'IFCRECTANGLEPROFILEDEF', "#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,#18,0.2,5.0);"],
      [15, 'IFCAXIS2PLACEMENT3D', '#15=IFCAXIS2PLACEMENT3D(#10,$,$);'],
      [16, 'IFCDIRECTION', '#16=IFCDIRECTION((0.,0.,1.));'],
      [17, 'IFCAXIS2PLACEMENT3D', '#17=IFCAXIS2PLACEMENT3D(#10,$,$);'],
      [18, 'IFCAXIS2PLACEMENT2D', '#18=IFCAXIS2PLACEMENT2D(#19,$);'],
      [19, 'IFCCARTESIANPOINT', '#19=IFCCARTESIANPOINT((0.,0.));'],
    ]);

    const closure = collectReferencedEntityIds(
      new Set([1]),
      source,
      entityIndex,
    );

    // Should include wall and all transitive references
    expect(closure.has(1)).toBe(true);   // root: IFCWALL
    expect(closure.has(2)).toBe(true);   // IFCOWNERHISTORY
    expect(closure.has(3)).toBe(true);   // IFCLOCALPLACEMENT
    expect(closure.has(4)).toBe(true);   // IFCPRODUCTDEFINITIONSHAPE
    expect(closure.has(5)).toBe(true);   // IFCPERSONANDORGANIZATION
    expect(closure.has(6)).toBe(true);   // IFCAXIS2PLACEMENT3D
    expect(closure.has(7)).toBe(true);   // IFCSHAPEREPRESENTATION
    expect(closure.has(10)).toBe(true);  // IFCCARTESIANPOINT (shared)
    expect(closure.has(12)).toBe(true);  // IFCEXTRUDEDAREASOLID
    expect(closure.has(13)).toBe(true);  // IFCGEOMETRICREPRESENTATIONCONTEXT
    expect(closure.has(19)).toBe(true);  // IFCCARTESIANPOINT (leaf)
    expect(closure.size).toBe(19);       // All entities reachable from wall
  });

  it('should handle multiple roots', () => {
    const { source, entityIndex } = buildTestData([
      [1, 'IFCWALL', "#1=IFCWALL('g1',#3,'W1',$,$,$,$,$);"],
      [2, 'IFCDOOR', "#2=IFCDOOR('g2',#3,'D1',$,$,$,$,$);"],
      [3, 'IFCOWNERHISTORY', '#3=IFCOWNERHISTORY($,$,$,$);'],
      [4, 'IFCSLAB', "#4=IFCSLAB('g3',#3,'S1',$,$,$,$,$);"],
    ]);

    const closure = collectReferencedEntityIds(
      new Set([1, 2]),
      source,
      entityIndex,
    );

    expect(closure.has(1)).toBe(true);   // root: wall
    expect(closure.has(2)).toBe(true);   // root: door
    expect(closure.has(3)).toBe(true);   // shared owner history
    expect(closure.has(4)).toBe(false);  // slab not reachable from roots
    expect(closure.size).toBe(3);
  });

  it('should handle circular references without infinite loop', () => {
    const { source, entityIndex } = buildTestData([
      [1, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', "#1=IFCRELCONTAINEDINSPATIALSTRUCTURE('g',$,$,$,(#2),#3);"],
      [2, 'IFCWALL', "#2=IFCWALL('g',#4,'W',$,#5,$,$,$);"],
      [3, 'IFCBUILDINGSTOREY', "#3=IFCBUILDINGSTOREY('g',#4,'S',$,$,$,$,$,$,$);"],
      [4, 'IFCOWNERHISTORY', '#4=IFCOWNERHISTORY(#1,$,$,$);'], // circular: references #1
      [5, 'IFCLOCALPLACEMENT', '#5=IFCLOCALPLACEMENT($,$);'],
    ]);

    const closure = collectReferencedEntityIds(
      new Set([1]),
      source,
      entityIndex,
    );

    // Should complete without infinite loop
    expect(closure.has(1)).toBe(true);
    expect(closure.has(2)).toBe(true);
    expect(closure.has(3)).toBe(true);
    expect(closure.has(4)).toBe(true);
    expect(closure.has(5)).toBe(true);
    expect(closure.size).toBe(5);
  });

  it('should handle empty root set', () => {
    const { source, entityIndex } = buildTestData([
      [1, 'IFCWALL', "#1=IFCWALL('g',$,'W',$,$,$,$,$);"],
    ]);

    const closure = collectReferencedEntityIds(
      new Set(),
      source,
      entityIndex,
    );

    expect(closure.size).toBe(0);
  });

  it('should not treat #N inside STEP string literals as references', () => {
    const { source, entityIndex } = buildTestData([
      [1, 'IFCWALL', "#1=IFCWALL('guid',$,'see detail #2 and #3',$,#4,$,$,$);"],
      [2, 'IFCRELDEFINESBYPROPERTIES', "#2=IFCRELDEFINESBYPROPERTIES('g2',$,$,$,(#5),#6);"],
      [3, 'IFCWALL', "#3=IFCWALL('g3',$,'B',$,$,$,$,$);"],
      [4, 'IFCLOCALPLACEMENT', '#4=IFCLOCALPLACEMENT($,$);'],
      [5, 'IFCWALL', "#5=IFCWALL('g5',$,'C',$,$,$,$,$);"],
      [6, 'IFCPROPERTYSET', "#6=IFCPROPERTYSET('g6',$,'P',$,());"],
    ]);

    const closure = collectReferencedEntityIds(new Set([1]), source, entityIndex);

    expect(closure.has(1)).toBe(true);
    expect(closure.has(4)).toBe(true);  // real reference
    expect(closure.has(2)).toBe(false); // '#2' only mentioned in a string
    expect(closure.has(3)).toBe(false); // '#3' only mentioned in a string
    expect(closure.has(6)).toBe(false); // reachable only through the phantom #2
  });

  it("should keep scanning correctly across the STEP '' quote escape", () => {
    const { source, entityIndex } = buildTestData([
      [1, 'IFCWALL', "#1=IFCWALL('guid',$,'it''s #2, isn''t it',$,#3,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'A',$,$,$,$,$);"],
      [3, 'IFCLOCALPLACEMENT', '#3=IFCLOCALPLACEMENT($,$);'],
    ]);

    const closure = collectReferencedEntityIds(new Set([1]), source, entityIndex);

    expect(closure.has(2)).toBe(false); // '#2' stays inside the escaped string
    expect(closure.has(3)).toBe(true);  // the real reference after it is still seen
  });

  it('should skip references to non-existent entities', () => {
    const { source, entityIndex } = buildTestData([
      [1, 'IFCWALL', "#1=IFCWALL('g',#999,'W',$,$,$,$,$);"],
    ]);

    const closure = collectReferencedEntityIds(
      new Set([1]),
      source,
      entityIndex,
    );

    expect(closure.has(1)).toBe(true);
    expect(closure.has(999)).toBe(false); // Not in entity index
    expect(closure.size).toBe(1);
  });

  it('should block excluded IDs from being followed', () => {
    // Simulate: relationship references both a visible wall (#2) and a hidden wall (#3).
    // Hidden wall's geometry (#30, #31) should NOT be pulled in.
    const { source, entityIndex } = buildTestData([
      [1, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', "#1=IFCRELCONTAINEDINSPATIALSTRUCTURE('g',$,$,$,(#2,#3),#4);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'Visible',$,#20,#21,$,$);"],
      [3, 'IFCWALL', "#3=IFCWALL('g3',$,'Hidden',$,#30,#31,$,$);"],
      [4, 'IFCBUILDINGSTOREY', "#4=IFCBUILDINGSTOREY('g4',$,'S',$,$,$,$,$,$,$);"],
      [20, 'IFCLOCALPLACEMENT', '#20=IFCLOCALPLACEMENT($,$);'],
      [21, 'IFCPRODUCTDEFINITIONSHAPE', '#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));'],
      [22, 'IFCEXTRUDEDAREASOLID', '#22=IFCEXTRUDEDAREASOLID($,$,$,2.5);'],
      [30, 'IFCLOCALPLACEMENT', '#30=IFCLOCALPLACEMENT($,$);'],
      [31, 'IFCPRODUCTDEFINITIONSHAPE', '#31=IFCPRODUCTDEFINITIONSHAPE($,$,(#32));'],
      [32, 'IFCEXTRUDEDAREASOLID', '#32=IFCEXTRUDEDAREASOLID($,$,$,3.0);'],
    ]);

    const closure = collectReferencedEntityIds(
      new Set([1, 2, 4]),  // roots: relationship, visible wall, storey
      source,
      entityIndex,
      new Set([3]),         // exclude: hidden wall
    );

    // Visible wall and its geometry should be included
    expect(closure.has(1)).toBe(true);   // relationship (root)
    expect(closure.has(2)).toBe(true);   // visible wall (root)
    expect(closure.has(4)).toBe(true);   // storey (root)
    expect(closure.has(20)).toBe(true);  // visible wall's placement
    expect(closure.has(21)).toBe(true);  // visible wall's shape
    expect(closure.has(22)).toBe(true);  // visible wall's geometry

    // Hidden wall and its geometry should be excluded
    expect(closure.has(3)).toBe(false);  // hidden wall (blocked)
    expect(closure.has(30)).toBe(false); // hidden wall's placement (unreachable)
    expect(closure.has(31)).toBe(false); // hidden wall's shape (unreachable)
    expect(closure.has(32)).toBe(false); // hidden wall's geometry (unreachable)
  });

  it('should include shared geometry even when one referencing product is excluded', () => {
    // Shared placement #10 is used by both visible wall #1 and hidden wall #2.
    // It should still be included because visible wall references it.
    const { source, entityIndex } = buildTestData([
      [1, 'IFCWALL', "#1=IFCWALL('g1',$,'Visible',$,#10,$,$,$);"],
      [2, 'IFCWALL', "#2=IFCWALL('g2',$,'Hidden',$,#10,$,$,$);"],
      [10, 'IFCLOCALPLACEMENT', '#10=IFCLOCALPLACEMENT($,#11);'],
      [11, 'IFCCARTESIANPOINT', '#11=IFCCARTESIANPOINT((0.,0.,0.));'],
    ]);

    const closure = collectReferencedEntityIds(
      new Set([1]),    // root: visible wall only
      source,
      entityIndex,
      new Set([2]),    // exclude: hidden wall
    );

    expect(closure.has(1)).toBe(true);   // visible wall
    expect(closure.has(10)).toBe(true);  // shared placement (reached via visible wall)
    expect(closure.has(11)).toBe(true);  // point (reached via placement)
    expect(closure.has(2)).toBe(false);  // hidden wall (excluded)
  });

  // CodeRabbit finding on #2637: `relationshipRefGroupsFromSourceLine` (via
  // `extractRelationshipRefGroupsIndexed`) only walks ONE level of
  // parenthesised nesting. A DOUBLY-nested list of entity refs — a real IFC
  // shape, e.g. `IfcBSplineSurfaceWithKnots.ControlPointsList: LIST OF LIST
  // OF IfcCartesianPoint` — has each inner `(#N,#N)` group fail the bare
  // `#(\d+)` match, so the whole attribute is discarded as "contains a
  // non-ref item" and every ref inside it is lost. This only bites a
  // source-backed entity with a queued mutation elsewhere on the SAME record
  // (`hasSourceMutation` gates the parse-instead-of-byte-scan path) — an
  // unmutated entity still takes the plain `extractRefsFromBytes` scan below,
  // which has no such blind spot.
  it('does not drop refs inside a doubly-nested list attribute on a mutated entity', () => {
    const { source, entityIndex: base } = buildTestData([
      [1, 'IFCBSPLINESURFACEWITHKNOTS', '#1=IFCBSPLINESURFACEWITHKNOTS(3,3,((#10,#11),(#12,#13)),.UNSPECIFIED.,$,$,$);'],
      [10, 'IFCCARTESIANPOINT', '#10=IFCCARTESIANPOINT((0.,0.,0.));'],
      [11, 'IFCCARTESIANPOINT', '#11=IFCCARTESIANPOINT((1.,0.,0.));'],
      [12, 'IFCCARTESIANPOINT', '#12=IFCCARTESIANPOINT((0.,1.,0.));'],
      [13, 'IFCCARTESIANPOINT', '#13=IFCCARTESIANPOINT((1.,1.,0.));'],
    ]);
    // Mark #1 as carrying a queued mutation on SOME other attribute (the
    // gate cares only that a mutation is queued for the id, not which
    // attribute) so the closure takes the parse-based path instead of the
    // plain byte scan.
    const entityIndex = {
      get: (id: number) => base.get(id),
      has: (id: number) => base.has(id),
      hasSourceMutation: (id: number) => id === 1,
    };

    const closure = collectReferencedEntityIds(new Set([1]), source, entityIndex);

    expect(closure.has(1)).toBe(true);
    expect(closure.has(10)).toBe(true);
    expect(closure.has(11)).toBe(true);
    expect(closure.has(12)).toBe(true);
    expect(closure.has(13)).toBe(true);
  });
});

describe('getVisibleEntityIds', () => {
  function createMockDataStore(
    entries: Array<[number, string]>,
  ): IfcDataStore {
    const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
    const byType = new Map<string, number[]>();

    for (const [id, type] of entries) {
      byId.set(id, { expressId: id, type, byteOffset: 0, byteLength: 0, lineNumber: 0 });
      const upper = type.toUpperCase();
      if (!byType.has(upper)) byType.set(upper, []);
      byType.get(upper)!.push(id);
    }

    return {
      entityIndex: { byId, byType },
      source: new Uint8Array(0),
    } as unknown as IfcDataStore;
  }

  it('should categorize entities correctly when nothing is hidden', () => {
    const store = createMockDataStore([
      [1, 'IFCPROJECT'],
      [2, 'IFCSITE'],
      [3, 'IFCBUILDING'],
      [4, 'IFCBUILDINGSTOREY'],
      [5, 'IFCWALL'],
      [6, 'IFCDOOR'],
      [7, 'IFCOWNERHISTORY'],
      [8, 'IFCRELCONTAINEDINSPATIALSTRUCTURE'],
      [9, 'IFCCARTESIANPOINT'],
      [10, 'IFCPROPERTYSET'],
    ]);

    const { roots, hiddenProductIds } = getVisibleEntityIds(store, new Set(), null);

    // Infrastructure, spatial, products, and relationships are roots
    expect(roots.has(1)).toBe(true);   // IFCPROJECT (spatial)
    expect(roots.has(2)).toBe(true);   // IFCSITE (spatial)
    expect(roots.has(5)).toBe(true);   // IFCWALL (visible product)
    expect(roots.has(6)).toBe(true);   // IFCDOOR (visible product)
    expect(roots.has(7)).toBe(true);   // IFCOWNERHISTORY (infrastructure)
    expect(roots.has(8)).toBe(true);   // IFCRELCONTAINEDINSPATIALSTRUCTURE (relationship)

    // Geometry and properties are NOT roots
    expect(roots.has(9)).toBe(false);  // IFCCARTESIANPOINT (reached via closure)
    expect(roots.has(10)).toBe(false); // IFCPROPERTYSET (reached via closure)

    expect(hiddenProductIds.size).toBe(0);
  });

  it('should exclude hidden products and track them as hiddenProductIds', () => {
    const store = createMockDataStore([
      [1, 'IFCPROJECT'],
      [5, 'IFCWALL'],
      [6, 'IFCDOOR'],
      [7, 'IFCWINDOW'],
      [8, 'IFCRELDEFINESBYPROPERTIES'],
    ]);

    const { roots, hiddenProductIds } = getVisibleEntityIds(store, new Set([5, 7]), null);

    expect(roots.has(1)).toBe(true);   // spatial (always)
    expect(roots.has(6)).toBe(true);   // visible door
    expect(roots.has(8)).toBe(true);   // relationship (always)
    expect(roots.has(5)).toBe(false);  // hidden wall
    expect(roots.has(7)).toBe(false);  // hidden window

    expect(hiddenProductIds.has(5)).toBe(true);  // hidden wall tracked
    expect(hiddenProductIds.has(7)).toBe(true);  // hidden window tracked
    expect(hiddenProductIds.size).toBe(2);
  });

  it('should respect isolation (only isolated products visible)', () => {
    const store = createMockDataStore([
      [1, 'IFCPROJECT'],
      [2, 'IFCOWNERHISTORY'],
      [5, 'IFCWALL'],
      [6, 'IFCDOOR'],
      [7, 'IFCWINDOW'],
    ]);

    const { roots, hiddenProductIds } = getVisibleEntityIds(store, new Set(), new Set([5]));

    expect(roots.has(1)).toBe(true);   // spatial (always)
    expect(roots.has(2)).toBe(true);   // infrastructure (always)
    expect(roots.has(5)).toBe(true);   // isolated wall (visible)
    expect(roots.has(6)).toBe(false);  // not in isolated set
    expect(roots.has(7)).toBe(false);  // not in isolated set

    expect(hiddenProductIds.has(6)).toBe(true);  // not isolated → hidden
    expect(hiddenProductIds.has(7)).toBe(true);  // not isolated → hidden
  });

  it('should always include infrastructure and spatial regardless of filters', () => {
    const store = createMockDataStore([
      [1, 'IFCPROJECT'],
      [2, 'IFCSITE'],
      [3, 'IFCBUILDING'],
      [4, 'IFCBUILDINGSTOREY'],
      [5, 'IFCOWNERHISTORY'],
      [6, 'IFCAPPLICATION'],
      [7, 'IFCGEOMETRICREPRESENTATIONCONTEXT'],
      [8, 'IFCUNITASSIGNMENT'],
      [9, 'IFCSIUNIT'],
      [10, 'IFCWALL'],
    ]);

    // Hide the wall and isolate nothing visible
    const { roots, hiddenProductIds } = getVisibleEntityIds(store, new Set([10]), null);

    // All infrastructure and spatial structure must be present
    expect(roots.has(1)).toBe(true);   // IFCPROJECT
    expect(roots.has(2)).toBe(true);   // IFCSITE
    expect(roots.has(3)).toBe(true);   // IFCBUILDING
    expect(roots.has(4)).toBe(true);   // IFCBUILDINGSTOREY
    expect(roots.has(5)).toBe(true);   // IFCOWNERHISTORY
    expect(roots.has(6)).toBe(true);   // IFCAPPLICATION
    expect(roots.has(7)).toBe(true);   // IFCGEOMETRICREPRESENTATIONCONTEXT
    expect(roots.has(8)).toBe(true);   // IFCUNITASSIGNMENT
    expect(roots.has(9)).toBe(true);   // IFCSIUNIT

    expect(hiddenProductIds.has(10)).toBe(true); // hidden wall
  });

  it('should NOT include geometry/property types as roots', () => {
    const store = createMockDataStore([
      [1, 'IFCPROJECT'],
      [2, 'IFCWALL'],
      [10, 'IFCCARTESIANPOINT'],
      [11, 'IFCDIRECTION'],
      [12, 'IFCSHAPEREPRESENTATION'],
      [13, 'IFCPRODUCTDEFINITIONSHAPE'],
      [14, 'IFCEXTRUDEDAREASOLID'],
      [15, 'IFCPROPERTYSET'],
      [16, 'IFCPROPERTYSINGLEVALUE'],
      [17, 'IFCMATERIAL'],
      [18, 'IFCWALLTYPE'],
      [19, 'IFCLOCALPLACEMENT'],
    ]);

    const { roots } = getVisibleEntityIds(store, new Set(), null);

    expect(roots.has(1)).toBe(true);   // spatial
    expect(roots.has(2)).toBe(true);   // product

    // None of these should be roots — they are reached via closure only
    expect(roots.has(10)).toBe(false);
    expect(roots.has(11)).toBe(false);
    expect(roots.has(12)).toBe(false);
    expect(roots.has(13)).toBe(false);
    expect(roots.has(14)).toBe(false);
    expect(roots.has(15)).toBe(false);
    expect(roots.has(16)).toBe(false);
    expect(roots.has(17)).toBe(false);
    expect(roots.has(18)).toBe(false);
    expect(roots.has(19)).toBe(false);
  });
});

/**
 * A source-less store (server-parsed, synthetic, GLB, point cloud) can still
 * carry overlay-authored `IfcRelVoidsElement` records, and those serve their
 * ends from the creation payload rather than from bytes.
 *
 * The guard in front of the byte scan used to be `if (!source) return`, which
 * never fired -- even a zero-length `Uint8Array` is truthy. Rewriting it as an
 * early `byteLength === 0` return during the accessor migration (#2339) would
 * have silently skipped the authored branch too, dropping opening-exclusion
 * propagation for exactly those stores. Pin the behaviour so it cannot narrow
 * again.
 */
describe('propagateOpeningExclusions without a source (#2339)', () => {
  const WALL = 10;
  const OPENING = 20;
  const REL = 30;

  function sourcelessStore(): IfcDataStore {
    return {
      source: EMPTY_SOURCE_BYTES,
      entityIndex: {
        byId: new Map([
          [WALL, { type: 'IFCWALL', byteOffset: 0, byteLength: 0 }],
          [OPENING, { type: 'IFCOPENINGELEMENT', byteOffset: 0, byteLength: 0 }],
          [REL, { type: 'IFCRELVOIDSELEMENT', byteOffset: 0, byteLength: 0 }],
        ]),
        byType: new Map([
          ['IFCWALL', [WALL]],
          ['IFCOPENINGELEMENT', [OPENING]],
          ['IFCRELVOIDSELEMENT', [REL]],
        ]),
      },
    } as unknown as IfcDataStore;
  }

  /** Minimal overlay index that authors the relation's two ends. */
  function overlayIndex(store: IfcDataStore): EffectiveEntityIndex {
    const byId = store.entityIndex.byId;
    return {
      byType: store.entityIndex.byType,
      get: (id: number) => byId.get(id),
      effectiveType: (_id: number, type: string) => type.toUpperCase(),
      refsOf: (id: number) => (id === REL ? [WALL, OPENING] : undefined),
      [Symbol.iterator]: () => byId[Symbol.iterator](),
    } as unknown as EffectiveEntityIndex;
  }

  it('still excludes an opening whose wall is hidden', () => {
    const store = sourcelessStore();
    const { hiddenProductIds } = getVisibleEntityIds(
      store,
      new Set([WALL]),
      null,
      overlayIndex(store),
    );
    expect(hiddenProductIds.has(WALL)).toBe(true);
    // The propagation under test: it can only come from the authored refs,
    // because there are no bytes to scan.
    expect(hiddenProductIds.has(OPENING)).toBe(true);
  });

  it('skips a bytes-only relation without abandoning a later authored one', () => {
    // `continue`, not `break`. OverlayIndex.byType shallow-copies the source
    // buckets and APPENDS created ids, so a byte-scan relation is iterated
    // before an authored one. With `break` the authored relation is never
    // reached and its opening silently stays in the export. Without a second
    // relation in this order the two spellings are indistinguishable.
    const WALL2 = 11;
    const OPENING2 = 21;
    const REL_BYTES = 31;   // no authored refs -> takes the byte branch
    const REL_AUTHORED = 32;

    const byId = new Map([
      [WALL2, { type: 'IFCWALL', byteOffset: 0, byteLength: 0 }],
      [OPENING2, { type: 'IFCOPENINGELEMENT', byteOffset: 0, byteLength: 0 }],
      [REL_BYTES, { type: 'IFCRELVOIDSELEMENT', byteOffset: 0, byteLength: 0 }],
      [REL_AUTHORED, { type: 'IFCRELVOIDSELEMENT', byteOffset: -1, byteLength: 0 }],
    ]);
    const store = {
      source: EMPTY_SOURCE_BYTES,
      entityIndex: {
        byId,
        byType: new Map([
          ['IFCWALL', [WALL2]],
          ['IFCOPENINGELEMENT', [OPENING2]],
          // Byte-scan relation FIRST, mirroring the real append order.
          ['IFCRELVOIDSELEMENT', [REL_BYTES, REL_AUTHORED]],
        ]),
      },
    } as unknown as IfcDataStore;

    const index = {
      byType: store.entityIndex.byType,
      get: (id: number) => byId.get(id),
      effectiveType: (_id: number, type: string) => type.toUpperCase(),
      refsOf: (id: number) => (id === REL_AUTHORED ? [WALL2, OPENING2] : undefined),
      [Symbol.iterator]: () => byId[Symbol.iterator](),
    } as unknown as EffectiveEntityIndex;

    const { hiddenProductIds } = getVisibleEntityIds(store, new Set([WALL2]), null, index);
    expect(hiddenProductIds.has(OPENING2)).toBe(true);
  });

  it('leaves the opening visible when its wall is visible', () => {
    // Control: proves the assertion above is driven by the wall's hidden state
    // and not by the opening being unconditionally excluded.
    const store = sourcelessStore();
    const { hiddenProductIds } = getVisibleEntityIds(store, new Set(), null, overlayIndex(store));
    expect(hiddenProductIds.has(OPENING)).toBe(false);
  });
});

/**
 * The product-type classification must agree with the bundled IFC schema
 * tables, in BOTH directions:
 *   - every concrete IfcProduct subtype the schema declares is classified as a
 *     product root (otherwise a visible-only export silently drops it);
 *   - every name the classifier treats as a product really is an IfcProduct
 *     subtype in some schema (otherwise the classifier over-roots).
 *
 * The expectation is derived from `@ifc-lite/data`'s generated entity tables,
 * never from a hand-copied list — a hand copy would drift with the table it is
 * meant to check.
 */
describe('product-type classification vs the generated IFC schema', () => {
  function mockStore(entries: Array<[number, string]>): IfcDataStore {
    const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
    const byType = new Map<string, number[]>();
    for (const [id, type] of entries) {
      byId.set(id, { expressId: id, type, byteOffset: 0, byteLength: 0, lineNumber: 0 });
      const upper = type.toUpperCase();
      if (!byType.has(upper)) byType.set(upper, []);
      byType.get(upper)!.push(id);
    }
    return { entityIndex: { byId, byType }, source: new Uint8Array(0) } as unknown as IfcDataStore;
  }

  /** Concrete (instantiable) IfcProduct subtypes declared by one schema table. */
  function concreteProducts(table: readonly IfcEntityInfo[]): string[] {
    const parent = new Map(table.map(e => [e.name, e.parent]));
    const isProduct = (name: string): boolean => {
      let cursor: string | null | undefined = name;
      for (let guard = 0; cursor && guard < 64; guard++) {
        if (cursor === 'IfcProduct') return true;
        cursor = parent.get(cursor);
      }
      return false;
    };
    return table.filter(e => !e.abstract && e.name !== 'IfcProduct' && isProduct(e.name)).map(e => e.name);
  }

  const SCHEMA_TABLES: Array<[string, readonly IfcEntityInfo[]]> = [
    ['IFC2X3', ENTITIES_IFC2X3],
    ['IFC4', ENTITIES_IFC4],
    ['IFC4X3', ENTITIES_IFC4X3],
  ];

  /**
   * Anti-vacuity: named entities that must appear in the derived enumeration.
   * A count floor would go green on benign growth and stay silent on exactly
   * the schema whose types went missing, so the guard names them instead.
   * The IFC2X3-only entries are the ones the hand-written table omitted.
   */
  const REQUIRED_IN_ENUMERATION: Record<string, string[]> = {
    IFC2X3: [
      'IfcElectricDistributionPoint',
      'IfcElectricalElement',
      'IfcEquipmentElement',
      'IfcChamferEdgeFeature',
      'IfcRoundedEdgeFeature',
      'IfcStructuralLinearActionVarying',
      'IfcStructuralPlanarActionVarying',
      'IfcWall',
    ],
    IFC4: ['IfcWall', 'IfcFurniture', 'IfcShadingDevice'],
    IFC4X3: ['IfcWall', 'IfcKerb', 'IfcSign'],
  };

  for (const [version, table] of SCHEMA_TABLES) {
    it(`enumerates the ${version} products it is about to assert on`, () => {
      const products = new Set(concreteProducts(table));
      for (const required of REQUIRED_IN_ENUMERATION[version]) {
        expect(products.has(required), `${required} missing from the ${version} enumeration`).toBe(true);
      }
    });

    it(`roots every concrete ${version} IfcProduct subtype when nothing is hidden`, () => {
      const products = concreteProducts(table);
      const entries: Array<[number, string]> = products.map((name, i) => [i + 100, name.toUpperCase()]);
      const store = mockStore(entries);
      const { roots } = getVisibleEntityIds(store, new Set(), null);

      const dropped = entries.filter(([id]) => !roots.has(id)).map(([, type]) => type);
      expect(dropped, `${version} products dropped from a visible-only export`).toEqual([]);
    });
  }

  it('classifies nothing the schema does not declare as an IfcProduct subtype', () => {
    const declared = new Set<string>();
    for (const [, table] of SCHEMA_TABLES) {
      const parent = new Map(table.map(e => [e.name, e.parent]));
      for (const entity of table) {
        let cursor: string | null | undefined = parent.get(entity.name);
        for (let guard = 0; cursor && guard < 64; guard++) {
          if (cursor === 'IfcProduct') {
            declared.add(entity.name.toUpperCase());
            break;
          }
          cursor = parent.get(cursor);
        }
      }
    }

    expect(declared.size, 'schema enumeration is empty — the diff below would be vacuous').toBeGreaterThan(0);
    const strays = [...PRODUCT_TYPES].filter(name => !declared.has(name));
    expect(strays, 'classified as products but not IfcProduct subtypes in any bundled schema').toEqual([]);
  });

  it('does not root non-product entities (control)', () => {
    const controls: Array<[number, string]> = [
      [1, 'IFCCARTESIANPOINT'],
      [2, 'IFCPROPERTYSET'],
      [3, 'IFCPROPERTYSINGLEVALUE'],
      [4, 'IFCMATERIAL'],
      [5, 'IFCWALLTYPE'],
      [6, 'IFCLOCALPLACEMENT'],
      [7, 'IFCSHAPEREPRESENTATION'],
    ];
    const { roots } = getVisibleEntityIds(mockStore(controls), new Set(), null);
    const rooted = controls.filter(([id]) => roots.has(id)).map(([, type]) => type);
    expect(rooted, 'non-product entities must be reached through the closure, not rooted').toEqual([]);
  });

  it('drops an IFC2X3 electrical element only when it is actually hidden', () => {
    const store = mockStore([
      [1, 'IFCPROJECT'],
      [2, 'IFCBUILDINGSTOREY'],
      [3, 'IFCELECTRICDISTRIBUTIONPOINT'],
      [4, 'IFCELECTRICALELEMENT'],
    ]);

    const visible = getVisibleEntityIds(store, new Set(), null);
    expect(visible.roots.has(3)).toBe(true);
    expect(visible.roots.has(4)).toBe(true);

    const hidden = getVisibleEntityIds(store, new Set([3]), null);
    expect(hidden.roots.has(3)).toBe(false);
    expect(hidden.hiddenProductIds.has(3)).toBe(true);
    expect(hidden.roots.has(4)).toBe(true);
  });
});

describe('collectStyleEntities rescues IFCPRESENTATIONLAYERASSIGNMENT', () => {
  /**
   * A subset-export closure the forward walk from a product cannot reach:
   * IfcPresentationLayerAssignment.AssignedItems (#20 -> #10, the shape
   * representation already in the closure) is the only reference between the
   * two, and it points the wrong direction for a forward walk to find —
   * exactly the shape #3696 fixed for IfcMapConversion, this time for a
   * non-`IFCREL*` entity `getVisibleEntityIds` cannot root unconditionally.
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

  it('rescues IFCPRESENTATIONLAYERASSIGNMENT referencing a shape already in the closure', () => {
    const entries: Array<[number, string, string]> = [
      [10, 'IFCSHAPEREPRESENTATION', "#10=IFCSHAPEREPRESENTATION(#1,'Body','SweptSolid',(#11));"],
      [11, 'IFCEXTRUDEDAREASOLID', '#11=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      [20, 'IFCPRESENTATIONLAYERASSIGNMENT', "#20=IFCPRESENTATIONLAYERASSIGNMENT('Layer_Walls',$,(#10),$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);

    // RED: the closure has the shape but not the layer assignment naming it —
    // nothing in the closure points back at #20.
    const closure = new Set([10, 11]);
    expect(closure.has(20)).toBe(false);

    collectStyleEntities(closure, source, { byId, byType });

    // GREEN: rescued by the reverse pass.
    expect(closure.has(20)).toBe(true);
  });

  it('rescues the IFCPRESENTATIONLAYERWITHSTYLE subtype the same way', () => {
    const entries: Array<[number, string, string]> = [
      [10, 'IFCSHAPEREPRESENTATION', "#10=IFCSHAPEREPRESENTATION(#1,'Body','SweptSolid',(#11));"],
      [11, 'IFCEXTRUDEDAREASOLID', '#11=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      [21, 'IFCPRESENTATIONLAYERWITHSTYLE', "#21=IFCPRESENTATIONLAYERWITHSTYLE('Layer_Styled',$,(#10),$,.T.,.F.,.F.,$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);
    const closure = new Set([10, 11]);

    collectStyleEntities(closure, source, { byId, byType });

    expect(closure.has(21)).toBe(true);
  });

  it('does not rescue a layer assignment naming only entities outside the closure (control)', () => {
    const entries: Array<[number, string, string]> = [
      [10, 'IFCSHAPEREPRESENTATION', "#10=IFCSHAPEREPRESENTATION(#1,'Body','SweptSolid',(#11));"],
      [11, 'IFCEXTRUDEDAREASOLID', '#11=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      [99, 'IFCSHAPEREPRESENTATION', "#99=IFCSHAPEREPRESENTATION(#1,'Body','SweptSolid',(#98));"],
      [20, 'IFCPRESENTATIONLAYERASSIGNMENT', "#20=IFCPRESENTATIONLAYERASSIGNMENT('Layer_Elsewhere',$,(#99),$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);
    // Closure excludes #99 — the layer assignment names only entities
    // that never made it into this export's closure, so it must stay out too.
    const closure = new Set([10, 11]);

    collectStyleEntities(closure, source, { byId, byType });

    expect(closure.has(20)).toBe(false);
  });

  // RED (PR #3698 follow-up): the "control" case above only covers a layer
  // assignment naming EITHER an included item OR only excluded ones — never
  // one spanning BOTH, which is the realistic shape (one CAD layer naming
  // every wall's shape representation). `#20` is rescued correctly — #10 is
  // visible — but the pre-fix forward walk pulled in #99 unconditionally too,
  // because #99 exists in `entityIndex` and nothing checked whether it was
  // ever independently visible.
  it('does not resurrect an excluded item a rescued layer assignment ALSO names, alongside a visible one (#3698 follow-up)', () => {
    const entries: Array<[number, string, string]> = [
      [10, 'IFCSHAPEREPRESENTATION', "#10=IFCSHAPEREPRESENTATION(#1,'Body','SweptSolid',(#11));"],
      [11, 'IFCEXTRUDEDAREASOLID', '#11=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      // #99 is a real entity (exists in entityIndex) but was never reached by
      // the main closure walk — the shape representation of a HIDDEN wall.
      [99, 'IFCSHAPEREPRESENTATION', "#99=IFCSHAPEREPRESENTATION(#1,'Body','SweptSolid',(#98));"],
      [98, 'IFCEXTRUDEDAREASOLID', '#98=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      [20, 'IFCPRESENTATIONLAYERASSIGNMENT', "#20=IFCPRESENTATIONLAYERASSIGNMENT('Layer_Walls',$,(#10,#99),$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);
    const closure = new Set([10, 11]);

    collectStyleEntities(closure, source, { byId, byType });

    // GREEN: rescued via the visible member.
    expect(closure.has(20)).toBe(true);
    // RED before the fix: closure ended up [10, 11, 20, 99] — the hidden
    // wall's own shape representation, and transitively its solid, riding
    // in on the unconditional forward walk from #20.
    expect(closure.has(99)).toBe(false);
    expect(closure.has(98)).toBe(false);
  });

  // The task that motivated this fix flags IFCSTYLEDITEM/IFCSTYLEDREPRESENTATION
  // as sharing the SAME unguarded-forward-walk root cause (it predates #3698,
  // which only made it practically triggerable via layer assignments). Verify
  // rather than assume: an IFCSTYLEDREPRESENTATION.Items list can itself mix a
  // styled item over VISIBLE geometry with one over geometry belonging to a
  // HIDDEN product — schema allows an arbitrary IfcStyledItem per product to
  // be gathered under one shared IfcStyledRepresentation.
  it('does not resurrect a hidden product’s styled item via a shared IFCSTYLEDREPRESENTATION', () => {
    const entries: Array<[number, string, string]> = [
      // Visible geometry + its styled item.
      [10, 'IFCEXTRUDEDAREASOLID', '#10=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      [30, 'IFCSTYLEDITEM', '#30=IFCSTYLEDITEM(#10,$,$);'],
      // Hidden product's OWN geometry + its OWN styled item — never reached
      // by the main closure walk (#99 is not in `closure` below).
      [99, 'IFCEXTRUDEDAREASOLID', '#99=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      [31, 'IFCSTYLEDITEM', '#31=IFCSTYLEDITEM(#99,$,$);'],
      // One shared IFCSTYLEDREPRESENTATION gathering both styled items —
      // analogous to one CAD layer naming both walls' geometry.
      [50, 'IFCSTYLEDREPRESENTATION', "#50=IFCSTYLEDREPRESENTATION(#1,'Style','Style',(#30,#31));"],
    ];
    const { source, byId, byType } = buildIndex(entries);
    const closure = new Set([10]);

    collectStyleEntities(closure, source, { byId, byType });

    // GREEN: rescued via the visible styled item.
    expect(closure.has(30)).toBe(true);
    expect(closure.has(50)).toBe(true);
    // The hidden product's OWN styled item (and, transitively, ITS geometry)
    // must stay out — it is reachable from #50 only alongside #30, the same
    // shape as the layer-assignment case above.
    expect(closure.has(31)).toBe(false);
    expect(closure.has(99)).toBe(false);
  });

  // `excludeIds` is threaded through independently of the geometry-type
  // guard above (matching `collectGeoreferencingEntities`'s shape) — this
  // pins that it does real work of its own, for a referenced id the
  // geometry-type check alone would not catch (a non-geometry-classified
  // type, e.g. a directly-excluded id that is not representation geometry).
  it('honours excludeIds directly in the forward walk, independent of the geometry-type guard', () => {
    const entries: Array<[number, string, string]> = [
      [10, 'IFCSHAPEREPRESENTATION', "#10=IFCSHAPEREPRESENTATION(#1,'Body','SweptSolid',(#11));"],
      [11, 'IFCEXTRUDEDAREASOLID', '#11=IFCEXTRUDEDAREASOLID(#12,#13,#14,3.);'],
      // #77 is NOT geometry-classified (IFCPROPERTYSET), so the geometry-type
      // guard alone would happily add it — only `excludeIds` stops it here.
      [77, 'IFCPROPERTYSET', "#77=IFCPROPERTYSET('g',$,'P',$,());"],
      [20, 'IFCPRESENTATIONLAYERASSIGNMENT', "#20=IFCPRESENTATIONLAYERASSIGNMENT('Layer_Walls',$,(#10,#77),$);"],
    ];
    const { source, byId, byType } = buildIndex(entries);
    const closure = new Set([10, 11]);

    collectStyleEntities(closure, source, { byId, byType }, new Set([77]));

    expect(closure.has(20)).toBe(true);
    expect(closure.has(77)).toBe(false);
  });
});

/**
 * #3789 follow-up: `filterHiddenRefsFromRelationshipLine`'s own record regex
 * required its type name immediately adjacent to '(' -- unlike
 * `entity-extractor.ts`'s sibling fix. The fallback on a failed parse is
 * "return the line UNCHANGED" (not null, not stripped), so a wrapped or
 * commented relationship line silently kept every hidden/deleted `#N` it
 * named instead of stripping them -- a dangling-reference leak, the opposite
 * of #2398's "narrow this line" contract.
 */
describe('filterHiddenRefsFromRelationshipLine: trivia between the type name and "(" (#3789)', () => {
  it('strips an excluded id from a list argument on a line wrapped across a CRLF', () => {
    const line = '#5=IFCRELAGGREGATES\r\n(\'GUID\',$,$,$,#1,(#2,#3));';
    const out = filterHiddenRefsFromRelationshipLine(line, (id) => id === 3);
    expect(out).toBe('#5=IFCRELAGGREGATES\r\n(\'GUID\',$,$,$,#1,(#2));');
  });

  it('strips an excluded id from a list argument on a line carrying a comment before "("', () => {
    const line = "#5=IFCRELAGGREGATES/* c */('GUID',$,$,$,#1,(#2,#3));";
    const out = filterHiddenRefsFromRelationshipLine(line, (id) => id === 3);
    expect(out).toBe("#5=IFCRELAGGREGATES/* c */('GUID',$,$,$,#1,(#2));");
  });

  it('a comment containing "(" or ";" does not derail the parse (control)', () => {
    const line = "#5=IFCRELAGGREGATES/* has ( and ; inside */('GUID',$,$,$,#1,(#2,#3));";
    const out = filterHiddenRefsFromRelationshipLine(line, (id) => id === 3);
    expect(out).toBe("#5=IFCRELAGGREGATES/* has ( and ; inside */('GUID',$,$,$,#1,(#2));");
  });

  it('two-way rule: an unterminated comment before "(" leaves the line unchanged (falls through, not corrupted)', () => {
    const line = "#5=IFCRELAGGREGATES/* never closes ('GUID',$,$,$,#1,(#2,#3));";
    expect(filterHiddenRefsFromRelationshipLine(line, (id) => id === 3)).toBe(line);
  });

  it('still narrows an adjacent line correctly (no regression)', () => {
    const line = "#5=IFCRELAGGREGATES('GUID',$,$,$,#1,(#2,#3));";
    const out = filterHiddenRefsFromRelationshipLine(line, (id) => id === 3);
    expect(out).toBe("#5=IFCRELAGGREGATES('GUID',$,$,$,#1,(#2));");
  });

  // CodeRabbit finding on this PR: widening the record regex put the trivia
  // INSIDE the prefix capture, and the entity type was sliced back out of
  // that prefix -- so a commented record produced the type
  // `IFCRELCONNECTSSTRUCTURALMEMBER/* c */`, which matches nothing in
  // `isOptionalTrailingRef`'s table. The optional 10th attribute would then
  // take the general withhold path and drop the WHOLE relationship instead
  // of rewriting the ref to `$`. `.trim()` hid the whitespace-only form of
  // the same defect, which is why only the comment case is RED here.
  it('rewrites the optional trailing ref to $ when a comment sits before "(" (type must survive the trivia)', () => {
    const line = "#1=IFCRELCONNECTSSTRUCTURALMEMBER/* c */('G',$,$,$,#2,#3,$,$,$,#9);";
    const out = filterHiddenRefsFromRelationshipLine(line, (id) => id === 9);
    expect(out).toBe("#1=IFCRELCONNECTSSTRUCTURALMEMBER/* c */('G',$,$,$,#2,#3,$,$,$,$);");
  });

  it('rewrites the optional trailing ref to $ when the record wraps before "("', () => {
    const line = "#1=IFCRELCONNECTSSTRUCTURALMEMBER\r\n('G',$,$,$,#2,#3,$,$,$,#9);";
    const out = filterHiddenRefsFromRelationshipLine(line, (id) => id === 9);
    expect(out).toBe("#1=IFCRELCONNECTSSTRUCTURALMEMBER\r\n('G',$,$,$,#2,#3,$,$,$,$);");
  });

  it('the adjacent form behaves identically (control -- the trivia is what was at risk)', () => {
    const line = "#1=IFCRELCONNECTSSTRUCTURALMEMBER('G',$,$,$,#2,#3,$,$,$,#9);";
    const out = filterHiddenRefsFromRelationshipLine(line, (id) => id === 9);
    expect(out).toBe("#1=IFCRELCONNECTSSTRUCTURALMEMBER('G',$,$,$,#2,#3,$,$,$,$);");
  });

  it('two-way rule: a commented NON-exempt relationship still withholds the whole line', () => {
    const line = "#1=IFCRELCONNECTSWITHECCENTRICITY/* c */('G',$,$,$,#2,#3,$,$,$,#9,#8);";
    expect(filterHiddenRefsFromRelationshipLine(line, (id) => id === 9)).toBeNull();
  });
});
