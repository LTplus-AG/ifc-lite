/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { collectReferencedEntityIds, getVisibleEntityIds } from './reference-collector.js';
import type { IfcDataStore } from '@ifc-lite/parser';

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
