/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "How many objects are on storey '00 Groundfloor'?" — the number the browser
 * puts on a spatial row, and the hover that explains it.
 *
 * The headline counts physical objects that have a shape: the schema test in
 * `lib/physical-objects.ts` AND the tree's own `renders`. Each condition rules
 * out a different row here, which is why both are needed — the annotation has
 * a shape and is not an object, the marker proxy is an object and has no
 * shape. The same fixture carries a group, a zone, a system, a property set
 * and the spatial chain, none of which may reach any count in any state.
 *
 * Every case is stated in both geometry states, because the number a user
 * reads mid-load is the one they will quote back.
 */

// happy-dom first: importing the tree builder pulls in the viewer store,
// whose persistence layer reads localStorage at module init and logs a
// ReferenceError without it. Registering the globals keeps that noise out of
// the runner's output, where a stray ReferenceError reads as a dead import.
import '@/test/setup-dom';
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcTypeEnum, RelationshipType, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { buildTreeData, buildTypeTree, buildUnifiedStoreys } from './treeDataBuilder';
import { isPhysicalObjectType } from '@/lib/physical-objects';

const STOREY_ID = 4;

/** #10 IfcWall, #11 IfcDoor and the #60 assembly (whose #61 beam carries its
 *  geometry) are the objects on the storey; #12 IfcAnnotation is a drafting
 *  aid; #50 is a shapeless marker proxy; #20/#21/#22 are a group, a zone and a
 *  system; #30 is a property set; #40 is a rendering IfcSpace holding #41.
 *  Legacy mode → globalId === expressId. */
const TYPES: Record<number, string> = {
  1: 'IfcProject', 2: 'IfcSite', 3: 'IfcBuilding', 4: 'IfcBuildingStorey',
  10: 'IfcWall', 11: 'IfcDoor', 12: 'IfcAnnotation',
  20: 'IfcGroup', 21: 'IfcZone', 22: 'IfcSystem', 30: 'IfcPropertySet',
  40: 'IfcSpace', 41: 'IfcFurniture', 50: 'IfcBuildingElementProxy',
  60: 'IfcElementAssembly', 61: 'IfcBeam', 62: 'IfcElementAssembly',
};
const NAMES: Record<number, string> = {
  4: '00 Groundfloor', 10: 'Basic Wall', 11: 'Single Door', 12: 'Dimension',
  20: 'Cost Group', 21: 'Fire Compartment', 22: 'HVAC', 30: 'Pset_Common',
  40: 'Living Room', 41: 'Sofa', 50: 'Group#21',
  60: 'Truss', 61: 'Truss Beam', 62: 'Truss Panel',
};
const ORDER = [1, 2, 3, 4, 10, 11, 12, 20, 21, 22, 30, 40, 41, 50, 60, 61, 62];

/** The annotation carries a 2D representation, so it is in the mesh set — the
 *  exact case the "does it have geometry" proxy admitted as an object. The
 *  site is in it too: site terrain is a mesh in most real models, so a
 *  spatial container that renders is the ordinary case, not a contrived one. */
const GEOMETRY_LOADED = new Set([2, 10, 11, 12, 40, 41, 61]);
/** Before the first geometry batch commits. */
const GEOMETRY_ABSENT = new Set<number>();

function node(expressId: number, type: IfcTypeEnum, name: string, children: SpatialNode[] = []): SpatialNode {
  return { expressId, type, name, children, elements: [] };
}

function createStoreyDataStore(): IfcDataStore {
  const space = node(40, IfcTypeEnum.IfcSpace, 'Living Room');
  const storey = node(STOREY_ID, IfcTypeEnum.IfcBuildingStorey, '00 Groundfloor', [space]);
  const building = node(3, IfcTypeEnum.IfcBuilding, 'Building', [storey]);
  const site = node(2, IfcTypeEnum.IfcSite, 'Site', [building]);
  const project = node(1, IfcTypeEnum.IfcProject, 'Project', [site]);

  const spatialHierarchy: SpatialHierarchy = {
    project,
    // IfcRelContainedInSpatialStructure puts the wall, the door, the
    // annotation and the shapeless proxy on the storey. Groups/zones/systems
    // are assigned, not contained, so they never reach byStorey.
    byStorey: new Map([[STOREY_ID, [10, 11, 12, 50, 60]]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map([[40, [41]]]),
    storeyElevations: new Map([[STOREY_ID, 0]]),
    storeyHeights: new Map(),
    elementToStorey: new Map([
      [10, STOREY_ID], [11, STOREY_ID], [12, STOREY_ID], [50, STOREY_ID], [60, STOREY_ID],
    ]),
    getStoreyElements: () => [],
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [],
  };

  return {
    spatialHierarchy,
    entities: {
      count: ORDER.length,
      expressId: ORDER,
      flags: ORDER.map(() => 0),
      getName: (id: number) => NAMES[id] ?? '',
      getTypeName: (id: number) => TYPES[id] ?? 'Unknown',
    },
    relationships: {
      // #60 is a decomposing assembly TWO levels deep: no shape of its own,
      // nor has its #62 sub-assembly; the geometry is on #61 at the bottom.
      // A descent that stops after one level reports the truss as shapeless,
      // and no sample model in the corpus nests twice.
      getRelated: (id: number, relType: RelationshipType, direction: 'forward' | 'inverse') => {
        if (direction !== 'forward' || relType !== RelationshipType.Aggregates) return [];
        if (id === 60) return [62];
        if (id === 62) return [61];
        return [];
      },
    },
  } as unknown as IfcDataStore;
}

/** #4764 review (louistrue, PR #4765): the spatial path's own "Other" split
 *  (`emitElementsWithOtherBucket`) bucketed on `hasShape` alone, with no
 *  physical-object gate — unlike `AssemblyGeometry.isOther`, which the By
 *  Class / By Type tabs go through. The shared fixture's only IfcAnnotation
 *  (#12) is always in `GEOMETRY_LOADED`, so no case in this file could ever
 *  expose that: this extension adds #13, a second IfcAnnotation on the same
 *  storey, deliberately left OUT of the geometry set so it is schema-legal
 *  AND shapeless AND non-physical — the exact row the missing gate mishandled. */
const TYPES_WITH_SHAPELESS_ANNOTATION: Record<number, string> = { ...TYPES, 13: 'IfcAnnotation' };
const NAMES_WITH_SHAPELESS_ANNOTATION: Record<number, string> = { ...NAMES, 13: 'Dimension (no shape)' };
const ORDER_WITH_SHAPELESS_ANNOTATION = [...ORDER, 13];

function createStoreyDataStoreWithShapelessAnnotation(): IfcDataStore {
  const ds = createStoreyDataStore();
  const hierarchy = ds.spatialHierarchy!;
  hierarchy.byStorey.set(STOREY_ID, [...hierarchy.byStorey.get(STOREY_ID)!, 13]);
  hierarchy.elementToStorey.set(13, STOREY_ID);
  return {
    ...ds,
    entities: {
      count: ORDER_WITH_SHAPELESS_ANNOTATION.length,
      expressId: ORDER_WITH_SHAPELESS_ANNOTATION,
      flags: ORDER_WITH_SHAPELESS_ANNOTATION.map(() => 0),
      getName: (id: number) => NAMES_WITH_SHAPELESS_ANNOTATION[id] ?? '',
      getTypeName: (id: number) => TYPES_WITH_SHAPELESS_ANNOTATION[id] ?? 'Unknown',
    },
  } as unknown as IfcDataStore;
}

const EXPANDED = new Set(['root-1', 'root-1-2', 'root-1-2-3', 'root-1-2-3-4', 'root-1-2-3-4-40']);

function storeyNodeOf(ds: IfcDataStore, geometricIds?: Set<number>, expandedNodes: Set<string> = EXPANDED) {
  const nodes = buildTreeData(new Map(), ds, expandedNodes, false, [], undefined, geometricIds);
  const storey = nodes.find((n) => n.type === 'IfcBuildingStorey');
  assert.ok(storey, 'the storey row exists');
  return { nodes, storey };
}

describe("storey headline: physical objects that have a shape", () => {
  it('counts 2 objects on "00 Groundfloor" once geometry has streamed', () => {
    // Contained: wall, door, annotation, shapeless proxy. The annotation fails
    // the schema test, the proxy fails the shape test — two conditions, and
    // each rules out a different row.
    const { storey } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED);
    assert.strictEqual(storey.elementCount, 3);
    assert.deepStrictEqual(storey.countSummary?.typeCounts, [
      ['IfcDoor', 1], ['IfcElementAssembly', 1], ['IfcWall', 1],
    ]);
  });

  it('says so on hover while geometry is still loading, and counts every object', () => {
    // Nothing can be known to be meshless yet, so the shapeless proxy is
    // counted too. The number is provisional and the hover says it.
    const { storey } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_ABSENT);
    assert.strictEqual(storey.elementCount, 4);
    assert.strictEqual(storey.countSummary?.geometryKnown, false);
    assert.strictEqual(storey.countSummary?.withoutGeometry, 0, 'not "0 without geometry" — unknown');
  });

  it('reports the shapeless element on hover, and only when there is one', () => {
    const withMarker = storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED).storey;
    assert.strictEqual(withMarker.countSummary?.withoutGeometry, 1);

    // Give the marker a shape and the line has nothing to say any more.
    const clean = storeyNodeOf(createStoreyDataStore(), new Set([...GEOMETRY_LOADED, 50])).storey;
    assert.strictEqual(clean.countSummary?.withoutGeometry, 0);
    assert.strictEqual(clean.elementCount, 4);
  });

  it('leaves the storey\'s spaces and their contents out of the count, visibly', () => {
    // The space renders and holds a chair; neither it nor its contents roll up
    // into the storey. The hover line is what makes that decision visible.
    const { storey, nodes } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED);
    assert.strictEqual(storey.elementCount, 3, 'the furniture inside the space does not roll up');
    assert.strictEqual(storey.countSummary?.spacesNotCounted, 1);

    const space = nodes.find((n) => n.type === 'IfcSpace');
    assert.ok(space, 'the space is its own row, with its own count');
    assert.strictEqual(space.elementCount, 1, 'and the furniture counts there');
  });

  it('counts a decomposing assembly whose parts carry the geometry', () => {
    // #60 has no shape of its own; its beam does. It renders in 3D, so it is
    // an object — and the shape test is the SAME `renders` the By Class tab
    // uses, so neither tree can call it shapeless while the other lists it.
    const { storey } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED);
    assert.ok(
      storey.countSummary?.typeCounts.some(([type]) => type === 'IfcElementAssembly'),
      'the assembly counts once, through its parts',
    );
    assert.strictEqual(storey.countSummary?.withoutGeometry, 1, 'and only the marker is shapeless');
  });

  it('carries the semantic count breakdown used by the localized hover', () => {
    const { storey } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED);
    assert.strictEqual(storey.countSummary?.counted, 3);
    assert.deepStrictEqual(storey.countSummary?.typeCounts, [
      ['IfcDoor', 1], ['IfcElementAssembly', 1], ['IfcWall', 1],
    ]);
    assert.strictEqual(storey.countSummary?.withoutGeometry, 1);
    assert.strictEqual(storey.countSummary?.spacesNotCounted, 1);

    // Give the marker a shape and the model-quality line goes away: a
    // permanent "0 without geometry" row is noise, and the line appearing is
    // the signal.
    const clean = storeyNodeOf(createStoreyDataStore(), new Set([...GEOMETRY_LOADED, 50])).storey;
    assert.strictEqual(clean.countSummary?.withoutGeometry, 0);
  });

  it('says on hover that a mid-load number is provisional', () => {
    const { storey } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_ABSENT);
    assert.strictEqual(storey.countSummary?.geometryKnown, false);
  });

  it('still SHOWS every contained entity as a selectable row, the shapeless marker grayed under "Other"', () => {
    // Changing what the number counts must not remove anything from the tree:
    // the annotation and the shapeless marker stay inspectable. #50 (#4764's
    // motivating case — a proxy merely NAMED "Group#21", not an IfcGroup) has
    // no shape, so it is bucketed under one collapsed "Other" row instead of
    // mixed in with the normal rows.
    const expandedWithOther = new Set([...EXPANDED, 'root-1-2-3-4-other']);
    const { nodes } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED, expandedWithOther);
    const rows = nodes.filter((n) => n.type === 'element').map((n) => n.expressIds[0]);
    assert.deepStrictEqual(
      rows,
      [41, 10, 11, 12, 60, 50],
      'the space subtree first, then the storey\'s own shaped rows, then the expanded Other bucket',
    );
    const otherGroup = nodes.find((n) => n.type === 'other-group');
    assert.ok(otherGroup, 'the shapeless marker is bucketed under an "Other" node, not dropped');
    assert.strictEqual(otherGroup?.elementCount, 1);
    const markerRow = nodes.find((n) => n.type === 'element' && n.expressIds[0] === 50);
    assert.strictEqual(markerRow?.noGeometry, true, 'the row is flagged so it renders grayed out');
    assert.strictEqual(
      storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED).storey.countSummary?.rows,
      5,
      'five contained rows behind a headline of three — the bucket does not change the count',
    );
  });

  it('leaves every row where it was, with no "Other" bucket, while geometry is still loading', () => {
    // Absence is unanswerable mid-load — see `makeShapeTest`'s `geometryKnown`
    // gate — so nothing is grayed or bucketed yet, exactly like the count.
    const { nodes } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_ABSENT);
    assert.strictEqual(nodes.find((n) => n.type === 'other-group'), undefined);
    const rows = nodes.filter((n) => n.type === 'element').map((n) => n.expressIds[0]);
    assert.deepStrictEqual(rows, [41, 10, 11, 12, 50, 60]);
    assert.ok(rows.every((id) => {
      const row = nodes.find((n) => n.type === 'element' && n.expressIds[0] === id);
      return !row?.noGeometry;
    }), 'no row is grayed while geometry is unknown');
  });

  it('gates the spatial "Other" bucket on physical-object type, not shape alone (#4764 review)', () => {
    // #50 (IfcBuildingElementProxy, an object by schema) has no shape and
    // belongs under "Other". #13 (IfcAnnotation, NOT an object by schema —
    // `isPhysicalObjectType('IfcAnnotation') === false`) also has no shape,
    // but a drafting aid with no representation is schema-legal and normal:
    // it must render as an ordinary selectable row, not be swept into
    // "Other" or grayed, exactly like the By Class / By Type tabs already
    // treat it via `AssemblyGeometry.isOther`'s own physical-object gate.
    const expandedWithOther = new Set([...EXPANDED, 'root-1-2-3-4-other']);
    const { nodes } = storeyNodeOf(
      createStoreyDataStoreWithShapelessAnnotation(),
      GEOMETRY_LOADED,
      expandedWithOther,
    );

    const otherGroup = nodes.find((n) => n.type === 'other-group');
    assert.ok(otherGroup, 'the physical shapeless proxy (#50) still buckets under "Other"');
    assert.strictEqual(
      otherGroup?.elementCount,
      1,
      'the shapeless annotation (#13) must NOT join the physical proxy in "Other"',
    );
    assert.deepStrictEqual(
      otherGroup?.expressIds,
      [50],
      '"Other" contains only the physical shapeless row',
    );

    const annotationRow = nodes.find((n) => n.type === 'element' && n.expressIds[0] === 13);
    assert.ok(annotationRow, 'the shapeless annotation is still a normal selectable row');
    assert.ok(!annotationRow?.noGeometry, 'it is not flagged as a bucketed/grayed row');
  });

  it('agrees with the By Class tab about what belongs in "Other" (#4764 review parity)', () => {
    // Same fixture, both trees: the physical shapeless proxy (#50) buckets
    // under "Other" in BOTH; the non-physical shapeless annotation (#13)
    // buckets under "Other" in NEITHER (the By Class tab drops it outright,
    // since it neither renders nor is a physical object with no shape — see
    // `AssemblyGeometry.isOther`'s own contract; the spatial tab shows it as
    // a normal row instead, since it is not filtered by product-tree class).
    const ds = createStoreyDataStoreWithShapelessAnnotation();
    const expandedWithOther = new Set([...EXPANDED, 'root-1-2-3-4-other']);
    const { nodes: spatialNodes } = storeyNodeOf(ds, GEOMETRY_LOADED, expandedWithOther);
    const classNodes = buildTypeTree(new Map(), ds, new Set(['type-group-other']), false, GEOMETRY_LOADED);

    const spatialOtherIds = new Set(
      spatialNodes.find((n) => n.type === 'other-group')?.expressIds ?? [],
    );
    const classOtherIds = new Set(
      classNodes.find((n) => n.type === 'other-group')?.expressIds ?? [],
    );

    assert.deepStrictEqual(spatialOtherIds, new Set([50]));
    assert.deepStrictEqual(classOtherIds, new Set([50]));
    assert.strictEqual(spatialOtherIds.has(13), false);
    assert.strictEqual(classOtherIds.has(13), false);
  });
});

describe('unified storey headline', () => {
  const model = (id: string): FederatedModel => {
    const ifcDataStore = createStoreyDataStore();
    const hierarchy = ifcDataStore.spatialHierarchy!;
    hierarchy.byStorey.set(STOREY_ID, [...hierarchy.byStorey.get(STOREY_ID)!, 41]);
    return {
      id,
      name: id,
      idOffset: id === 'model-a' ? 100 : 200,
      maxExpressId: 61,
      ifcDataStore,
    } as unknown as FederatedModel;
  };

  const models = () => new Map([
    ['model-a', model('model-a')],
    ['model-b', model('model-b')],
  ]);

  it('uses the same space exclusion as each model tree', () => {
    const unified = buildUnifiedStoreys(new Map([
      ['model-a', model('model-a')],
      ['model-b', model('model-b')],
    ]));

    assert.strictEqual(unified.length, 1);
    assert.strictEqual(unified[0].objects.counted, 8, 'four direct objects per model');
    assert.strictEqual(unified[0].objects.spacesNotCounted, 2, 'one space per model');
    assert.ok(
      unified[0].storeys.every((storey) => !storey.elements.includes(41)),
      'an element also indexed under a descendant space is not duplicated in a contribution',
    );
  });

  it('reports the same number as the single-model badge on a #1075 rollup', () => {
    // `model()` above rolls the space's contents up into `byStorey` (#1075),
    // which is the list the per-model tree subtracts from. Counting it raw
    // makes the Storeys section and the model's own tree disagree about one
    // storey — the very defect this work exists to remove, reappearing inside
    // the fix. No sample model in the corpus rolls up, so a fixture must.
    const federation = models();
    const unified = buildUnifiedStoreys(federation, undefined, GEOMETRY_LOADED);
    const contribution = unified[0].storeys.find((storey) => storey.modelId === 'model-a');
    const single = storeyNodeOf(federation.get('model-a')!.ifcDataStore!, GEOMETRY_LOADED).storey;

    assert.strictEqual(
      contribution?.objects.counted,
      single.elementCount,
      'the Storeys section and the model tree must not answer differently',
    );
  });

  it('counts a store whose spatialHierarchy carries no project node', () => {
    // A cache-restored or synthetic store has the containment maps and no
    // `project`. Walking the tree from that root to reach each storey node
    // threw, taking the whole Models section down with it rather than just
    // the count — so the fallback is the raw containment list, not a crash.
    const projectless = (id: string): FederatedModel => {
      const built = model(id);
      const hierarchy = built.ifcDataStore!.spatialHierarchy as unknown as { project?: unknown };
      delete hierarchy.project;
      return built;
    };
    const unified = buildUnifiedStoreys(new Map([
      ['model-a', projectless('model-a')],
      ['model-b', projectless('model-b')],
    ]));

    assert.strictEqual(unified.length, 1);
    assert.strictEqual(unified[0].objects.rows, 12, 'the raw containment list, both models');
    assert.strictEqual(
      unified[0].objects.spacesNotCounted,
      0,
      'with no node to read children from, no space can be reported as excluded',
    );
  });

  it('treats a completed model with zero meshes as known-empty', () => {
    const unified = buildUnifiedStoreys(
      models(),
      'elevation-desc',
      new Set(),
      new Set(['model-a', 'model-b']),
    );

    assert.strictEqual(unified[0].objects.counted, 0);
    assert.strictEqual(unified[0].objects.withoutGeometry, 8);
    assert.strictEqual(unified[0].objects.geometryKnown, true);
  });

  it('does not apply one model\'s geometry readiness to an unstreamed sibling', () => {
    const federation = models();
    const unified = buildUnifiedStoreys(
      federation,
      'elevation-desc',
      new Set(),
      new Set(['model-a']),
    );

    assert.strictEqual(unified[0].objects.counted, 4, 'the unstreamed model stays optimistic');
    assert.strictEqual(unified[0].objects.withoutGeometry, 4, 'only the known-empty model is shapeless');
    assert.strictEqual(unified[0].objects.geometryKnown, false, 'the combined row remains provisional');

    const classNodes = buildTypeTree(
      federation,
      null,
      new Set(),
      true,
      new Set(),
      undefined,
      new Set(['model-a']),
    );
    const physicalRows = classNodes
      .filter((entry) => entry.type === 'type-group' && isPhysicalObjectType(entry.ifcType!))
      .reduce((sum, entry) => sum + (entry.elementCount ?? 0), 0);
    // 7, not 6: the truss now nests twice, so its sub-assembly is a row too.
    assert.strictEqual(physicalRows, 7, 'the By Class tab retains every physical row from model-b');
  });
});

describe('one question, one number: the two trees agree about a storey', () => {
  /** Ids the By Class tab lists as objects (its own rule, applied to the tab). */
  function objectIdsInClassTab(ds: IfcDataStore, geometricIds: Set<number>): Set<number> {
    const ids = new Set<number>();
    for (const n of buildTypeTree(new Map(), ds, new Set(), false, geometricIds)) {
      if (n.type !== 'type-group' || !isPhysicalObjectType(n.ifcType!)) continue;
      for (const id of n.expressIds) ids.add(id);
    }
    return ids;
  }

  for (const [label, geometricIds] of [
    ['geometry loaded', GEOMETRY_LOADED],
    ['geometry not yet streamed', GEOMETRY_ABSENT],
  ] as const) {
    it(`the storey headline equals the tab's objects on that storey (${label})`, () => {
      const ds = createStoreyDataStore();
      const { storey } = storeyNodeOf(ds, geometricIds);
      const inTab = objectIdsInClassTab(ds, geometricIds);
      const contained = [10, 11, 12, 50, 60].filter((id) => inTab.has(id));
      assert.strictEqual(
        contained.length,
        storey.elementCount,
        'the spatial badge and the class tab must not answer the same question differently',
      );
    });
  }
});

describe('By Class tab never lists a non-object, in either geometry state', () => {
  for (const [label, geometricIds, expectedClasses, expectedObjects] of [
    // No group, zone, system, property set or spatial container appears in
    // either state — that is the invariant. What legitimately differs is which
    // OBJECTS are listed: while the model streams nothing can be known to be
    // meshless, so every object is listed optimistically (the shapeless proxy
    // among them); once the filter is live the tab narrows to what renders.
    // The annotation and the space are shown only because they render, so they
    // appear in the loaded state and not before.
    ['geometry loaded', GEOMETRY_LOADED, ['IfcAnnotation', 'IfcBeam', 'IfcDoor', 'IfcElementAssembly', 'IfcFurniture', 'IfcSpace', 'IfcWall'], 6],
    ['geometry not yet streamed', GEOMETRY_ABSENT, ['IfcBeam', 'IfcBuildingElementProxy', 'IfcDoor', 'IfcElementAssembly', 'IfcFurniture', 'IfcWall'], 7],
  ] as const) {
    it(`lists neither groups, zones, systems, property sets nor the spatial chain (${label})`, () => {
      // The site carries terrain geometry in GEOMETRY_LOADED, so "it renders"
      // alone would put an IfcSite row in a tab that lists products.
      const nodes = buildTypeTree(new Map(), createStoreyDataStore(), new Set(), false, geometricIds);
      const classes = nodes.filter((n) => n.type === 'type-group').map((n) => n.ifcType).sort();
      assert.deepStrictEqual(classes, [...expectedClasses]);
    });

    it(`totals the objects that render across the tab (${label})`, () => {
      const nodes = buildTypeTree(new Map(), createStoreyDataStore(), new Set(), false, geometricIds);
      // Every row in this tab is an object except the deliberately shown
      // non-objects (annotation, space) — so the object total is the sum over
      // the rest. A leaked IfcGroup row breaks the first assertion below even
      // though it is not a physical type, so the total cannot be inflated by a
      // row the predicate happens to skip.
      const rows = nodes.filter((n) => n.type === 'type-group');
      const nonObjectRows = rows.filter((n) => !isPhysicalObjectType(n.ifcType!));
      assert.deepStrictEqual(
        nonObjectRows.map((n) => n.ifcType),
        expectedClasses.filter((c) => !isPhysicalObjectType(c)),
        'only the deliberately shown non-object classes may appear',
      );
      const total = rows
        .filter((n) => isPhysicalObjectType(n.ifcType!))
        .reduce((sum, n) => sum + (n.elementCount ?? 0), 0);
      assert.strictEqual(total, expectedObjects);
    });
  }

  it('has no "Other" bucket at all while geometry is still streaming (#4764)', () => {
    // Absence is unanswerable mid-load (`isOther`'s own `applyFilter` guard,
    // mirroring `makeAssemblyGeometry`'s `renders`) — #50 is shown as a normal
    // optimistic row instead (already covered above), and no "Other" node
    // exists to gray anything under.
    const nodes = buildTypeTree(new Map(), createStoreyDataStore(), new Set(), false, GEOMETRY_ABSENT);
    assert.strictEqual(nodes.find((n) => n.type === 'other-group'), undefined);
  });

  it('leaves a shapeless physical object out of the renders-oriented tab, grayed under "Other" instead (#4764)', () => {
    // #50 is an object by schema (IfcBuildingElementProxy carrying only a
    // placement, named "Group#21" — it is NOT an IfcGroup, just a proxy
    // someone named that way; see AGENTS.md's #4764 motivating case). It has
    // nothing to draw, so neither the tab nor the storey headline counts it —
    // but it stays findable, grayed out under a flat "Other" bucket instead
    // of its own IfcBuildingElementProxy class group or being dropped.
    const nodes = buildTypeTree(new Map(), createStoreyDataStore(), new Set(['type-group-other']), false, GEOMETRY_LOADED);
    assert.strictEqual(
      nodes.find((n) => n.type === 'type-group' && n.ifcType === 'IfcBuildingElementProxy'),
      undefined,
      'never its own class group — that would count it among the objects it is excluded from',
    );
    const otherGroup = nodes.find((n) => n.type === 'other-group');
    assert.ok(otherGroup, 'the By Class tab has an "Other" bucket');
    const markerRow = nodes.find((n) => n.type === 'element' && n.expressIds[0] === 50);
    assert.ok(markerRow, 'the marker is a row under it');
    assert.strictEqual(markerRow?.noGeometry, true);
    assert.strictEqual(markerRow?.ifcType, 'IfcBuildingElementProxy', 'its own class still rides along for context');

    const expandedWithOther = new Set([...EXPANDED, 'root-1-2-3-4-other']);
    const { storey, nodes: spatialNodes } = storeyNodeOf(createStoreyDataStore(), GEOMETRY_LOADED, expandedWithOther);
    assert.strictEqual(storey.elementCount, 3, 'the storey badge counts the objects that render');
    assert.ok(
      spatialNodes.some((n) => n.type === 'element' && n.expressIds[0] === 50),
      'and the spatial tab still lists it (under its own "Other" bucket), so it remains findable',
    );
  });

  it('SHOWS a rendering space without counting it as an object', () => {
    // Almost every architectural model has spaces, they usually DO carry
    // geometry, and they are spatial elements rather than objects — so the
    // "does it render" proxy counted them. The row stays (a space is a thing
    // the user selects); the object total above does not move.
    const nodes = buildTypeTree(new Map(), createStoreyDataStore(), new Set(), false, GEOMETRY_LOADED);
    const space = nodes.find((n) => n.type === 'type-group' && n.ifcType === 'IfcSpace');
    assert.ok(space, 'the IfcSpace class row is listed');
    assert.strictEqual(space.elementCount, 1);
    assert.strictEqual(isPhysicalObjectType('IfcSpace'), false, 'but it is not an object');
  });

  it('still SHOWS the annotation class so it stays selectable (#1480)', () => {
    const nodes = buildTypeTree(new Map(), createStoreyDataStore(), new Set(), false, GEOMETRY_LOADED);
    const annotation = nodes.find((n) => n.type === 'type-group' && n.ifcType === 'IfcAnnotation');
    assert.ok(annotation, 'the IfcAnnotation class row must survive the object rule');
    assert.strictEqual(annotation.elementCount, 1);
  });
});
