/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The PRECONDITION in front of the two `IFCREL*` reference filters, one test
 * per disjunct.
 *
 * `isOmittedFromOutput` decides WHAT a relationship line may name;
 * `mayNameOmittedRefs` decides WHETHER that decision is consulted at all.
 * Running the filter on every `IFCREL*` line instead costs +13% of a large
 * export (measured on 714k entities: 463 ms median gated, 523 ms
 * unconditional), and a large model is mostly relationships — so the gate is
 * not a micro-optimisation, it is the difference between the fix being
 * affordable and not.
 *
 * A gate is also exactly where this class of defect lives. The gate #2668
 * removed was a hand-kept second enumeration of "reasons an entity might be
 * excluded" that knew about hidden products and the overlay and nothing else,
 * so the unreadable-source-ref defect (#2491) reached the output with the
 * filter switched off. A first attempt at restoring a cheap gate repeated the
 * mistake one reason further along: it added an unreadable-ref disjunct and
 * still had none for `includeGeometry: false`, and ALL SIX tests in
 * `unreadable-ref-dangling.test.ts` stayed green while the export shipped a
 * dangling ref.
 *
 * Hence this file, and hence its shape. Each test below puts the exporter in a
 * state where exactly ONE disjunct of the gate is true, with the other three
 * demonstrably false, and asserts the output has no dangling `#N`. Delete any
 * one disjunct from the gate and exactly the matching test goes red; that is
 * the property this file exists to keep true as reasons are added.
 *
 * Behavioural only. No test here reads `step-exporter.ts`'s source text — the
 * pattern `scripts/check-source-text-assertions.mjs` exists to stop, and the
 * one that shipped in an earlier revision of `unreadable-ref-dangling.test.ts`
 * stayed green through a total gutting of `willBeEmitted`.
 */

import { describe, expect, it } from 'vitest';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createSourceRefReader } from './source-ref-bounds.js';
import { StepExporter, type StepExportOptions } from './step-exporter.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type MockEntityRef = {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
};

/** Same shape as `unreadable-ref-dangling.test.ts`'s file-parsed store. */
function buildParsedStore(entries: Array<[number, string, string]>): {
  store: IfcDataStore;
  byId: Map<number, MockEntityRef>;
} {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) {
    source.set(part, position);
    position += part.byteLength;
  }

  const store = {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;

  return { store, byId };
}

/** Every `#N` referenced in the output that has no `#N=` defining line. */
function findDanglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)\s*=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

/**
 * Asserts the OTHER disjuncts cannot be what made a test pass.
 *
 * Only the unreadable-ref disjunct needs asserting rather than reading off the
 * call: `visibleOnly`, `includeGeometry` and the mutation view are visible in
 * each test's own arguments, while "is every byte range in this fixture
 * addressable" is a property of the bytes a later edit to the fixture could
 * silently break — at which point the test would still pass, on the wrong
 * disjunct, and stop guarding the one it names.
 */
function expectEveryRefReadable(store: IfcDataStore, byId: Map<number, MockEntityRef>): void {
  const isReadableSourceRef = createSourceRefReader(store.source);
  for (const [id, ref] of byId) {
    expect(isReadableSourceRef(ref), `#${id} has an unreadable source ref`).toBe(true);
  }
}

const WALL_A = "#1=IFCWALL('0walA0000000000000000',$,'VisibleWall',$,$,$,$,$);\n";
const WALL_B = "#2=IFCWALL('0walB0000000000000000',$,'OtherWall',$,$,$,$,$);\n";
const STOREY = "#3=IFCBUILDINGSTOREY('0stor0000000000000000',$,'S',$,$,$,$,$,$,0.);\n";
const CONTAINMENT = "#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont0000000000000000',$,$,$,(#1,#2),#3);\n";

/** Two walls in one storey, the second of which each test below removes by a
 *  different route. Every byte range is exact. */
function buildTwoWallStore(): { store: IfcDataStore; byId: Map<number, MockEntityRef> } {
  return buildParsedStore([
    [1, 'IFCWALL', WALL_A],
    [2, 'IFCWALL', WALL_B],
    [3, 'IFCBUILDINGSTOREY', STOREY],
    [4, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', CONTAINMENT],
  ]);
}

describe('the relationship filter runs when the visible-only closure exists', () => {
  it('drops a hidden wall from the containment relation that names it', () => {
    const { store, byId } = buildTwoWallStore();
    expectEveryRefReadable(store, byId);

    const content = decode(new StepExporter(store).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set([2]),
    }).content);

    expect(content).not.toContain('#2=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
    expect(content).toMatch(/#4=IFCRELCONTAINEDINSPATIALSTRUCTURE\([^)]*\(#1\)/);
  });

  it('reads the closure STATE, not the option the closure was built from', () => {
    // The closure is built under `if (options.visibleOnly && ...)` — TRUTHY,
    // and a read of the caller's own object. Spelling the gate as
    // `options.visibleOnly === true` therefore asks a DIFFERENT question than
    // the one that produced `allowedEntityIds`, and the two can disagree: this
    // accessor answers `true` for the closure and `false` for a second reader.
    // `@ifc-lite/export` is published, so the plainer reachable form of the
    // same gap is a JS caller passing `visibleOnly: 1` — measured, 192 of an
    // 800-case option sweep shipped a dangling ref against the `=== true`
    // spelling and none against a gate that reads the closure it got.
    //
    // No cast: `visibleOnly?: boolean` is satisfied by an accessor, so this is
    // a shape a type-checked caller can also write.
    let reads = 0;
    const options: StepExportOptions = {
      schema: 'IFC4',
      hiddenEntityIds: new Set([2]),
      get visibleOnly(): boolean {
        return reads++ === 0;
      },
    };

    const content = decode(new StepExporter(buildTwoWallStore().store).export(options).content);

    expect(content).not.toContain('#2=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});

describe('the relationship filter runs when the overlay is active', () => {
  it('drops a tombstoned wall from the containment relation that names it', () => {
    const { store, byId } = buildTwoWallStore();
    expectEveryRefReadable(store, byId);

    // No `visibleOnly`, no `includeGeometry:false` — a plain full export whose
    // only exclusion is this session's own deletion.
    const view = new MutablePropertyView(null, 'gate-test');
    view.deleteEntity(2);

    const content = decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#2=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
    expect(content).toMatch(/#4=IFCRELCONTAINEDINSPATIALSTRUCTURE\([^)]*\(#1\)/);
  });
});

/**
 * `includeGeometry: false` is the reason that killed the first cheap-gate
 * attempt: it is the only one of the five with no trace in the store, no
 * overlay and no closure — just an option — so a gate assembled from "what
 * state is this export in" misses it entirely.
 *
 * IFC4 `IfcRelConnectsStructuralMember.ConditionCoordinateSystem` is an
 * optional `IfcAxis2Placement3D`, and `IFCAXIS2PLACEMENT3D` is in
 * `StepExporter.isGeometryEntity`'s set — so a schema-valid file has an
 * `IFCREL*` line naming an entity `includeGeometry: false` omits. Nothing
 * contrived is needed to reach it.
 */
function buildStructuralConnectionStore(): { store: IfcDataStore; byId: Map<number, MockEntityRef> } {
  return buildParsedStore([
    [1, 'IFCSTRUCTURALCURVEMEMBER', "#1=IFCSTRUCTURALCURVEMEMBER('0mem00000000000000000',$,'Beam',$,$,$,$,.RIGID_JOINED_MEMBER.,$);\n"],
    [2, 'IFCSTRUCTURALPOINTCONNECTION', "#2=IFCSTRUCTURALPOINTCONNECTION('0con00000000000000000',$,'Node',$,$,$,$,$,$);\n"],
    [4, 'IFCCARTESIANPOINT', '#4=IFCCARTESIANPOINT((0.,0.,0.));\n'],
    [5, 'IFCAXIS2PLACEMENT3D', '#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n'],
    [6, 'IFCRELCONNECTSSTRUCTURALMEMBER', "#6=IFCRELCONNECTSSTRUCTURALMEMBER('0rel00000000000000000',$,$,$,#1,#2,$,$,$,#5);\n"],
  ]);
}

describe('the relationship filter runs when geometry is excluded', () => {
  it('rewrites ConditionCoordinateSystem to $ instead of withholding the association', () => {
    const { store, byId } = buildStructuralConnectionStore();
    // Pins the isolation this test claims: no ref here is unreadable, so the
    // unreadable-ref disjunct is false and cannot be what runs the filter.
    expectEveryRefReadable(store, byId);

    const result = new StepExporter(store).export({ schema: 'IFC4', includeGeometry: false });
    const content = decode(result.content);

    // The omission: `#5` is geometry-classified, so the source pass skips it.
    expect(content).not.toContain('#5=IFCAXIS2PLACEMENT3D');
    expect(findDanglingRefs(content)).toEqual([]);
    // `ConditionCoordinateSystem` is OPTIONAL in both IFC4 and IFC4X3
    // (`IFC4_ADD2_TC1.exp:8523`, `IFC4X3.exp:9774`) and is the sole
    // `IFCREL*` attribute typed to an entity `isGeometryEntity` classifies —
    // so the relationship is rewritten with `$` in its place rather than
    // withheld, keeping #1 and #2's structural association and producing no
    // warning.
    expect(content).toMatch(
      /#6=IFCRELCONNECTSSTRUCTURALMEMBER\('0rel00000000000000000',\$,\$,\$,#1,#2,\$,\$,\$,\$\);/,
    );
    expect(result.stats.warnings).toHaveLength(0);

    // Not vacuous: the two non-geometry entities are still exported.
    expect(content).toContain('#1=IFCSTRUCTURALCURVEMEMBER');
    expect(content).toContain('#2=IFCSTRUCTURALPOINTCONNECTION');
  });

  it('rewrites ConditionCoordinateSystem to $ even when the source line has whitespace around "="', () => {
    // The line regex (`^(#\d+\s*=\s*\w+\(...)`) accepts whitespace around
    // `=` — legal STEP, and buildStructuralConnectionStore's own fixture text
    // never exercises it. Reuses the exact same entities/ids as the sibling
    // test above; the only difference is `#6 = IFCREL...` (space after `=`)
    // instead of `#6=IFCREL...`.
    const { store, byId } = buildParsedStore([
      [1, 'IFCSTRUCTURALCURVEMEMBER', "#1=IFCSTRUCTURALCURVEMEMBER('0mem00000000000000000',$,'Beam',$,$,$,$,.RIGID_JOINED_MEMBER.,$);\n"],
      [2, 'IFCSTRUCTURALPOINTCONNECTION', "#2=IFCSTRUCTURALPOINTCONNECTION('0con00000000000000000',$,'Node',$,$,$,$,$,$);\n"],
      [4, 'IFCCARTESIANPOINT', '#4=IFCCARTESIANPOINT((0.,0.,0.));\n'],
      [5, 'IFCAXIS2PLACEMENT3D', '#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n'],
      [6, 'IFCRELCONNECTSSTRUCTURALMEMBER', "#6 = IFCRELCONNECTSSTRUCTURALMEMBER('0rel00000000000000000',$,$,$,#1,#2,$,$,$,#5);\n"],
    ]);
    expectEveryRefReadable(store, byId);

    const result = new StepExporter(store).export({ schema: 'IFC4', includeGeometry: false });
    const content = decode(result.content);

    expect(content).not.toContain('#5=IFCAXIS2PLACEMENT3D');
    expect(findDanglingRefs(content)).toEqual([]);
    // If entityType retained a leading space, isOptionalTrailingRef's `===`
    // comparison would never match and the whole relationship would be
    // withheld instead of rewritten — the exact defect under test.
    expect(content).toMatch(
      /#6\s*=\s*IFCRELCONNECTSSTRUCTURALMEMBER\('0rel00000000000000000',\$,\$,\$,#1,#2,\$,\$,\$,\$\);/,
    );
    expect(result.stats.warnings).toHaveLength(0);
    expect(content).toContain('#1=IFCSTRUCTURALCURVEMEMBER');
    expect(content).toContain('#2=IFCSTRUCTURALPOINTCONNECTION');
  });

  it('withholds the eccentricity subtype instead, because its 11th attribute is mandatory', () => {
    // IfcRelConnectsWithEccentricity appends ConnectionConstraint (mandatory
    // IfcConnectionGeometry) after ConditionCoordinateSystem, so the position-
    // and-count-matched $ rewrite above must NOT fire here: attrCount is 11,
    // not 10, and this arm falls through to the general withhold rule.
    const { store } = buildParsedStore([
      [1, 'IFCSTRUCTURALCURVEMEMBER', "#1=IFCSTRUCTURALCURVEMEMBER('0mem00000000000000000',$,'Beam',$,$,$,$,.RIGID_JOINED_MEMBER.,$);\n"],
      [2, 'IFCSTRUCTURALPOINTCONNECTION', "#2=IFCSTRUCTURALPOINTCONNECTION('0con00000000000000000',$,'Node',$,$,$,$,$,$);\n"],
      [4, 'IFCCARTESIANPOINT', '#4=IFCCARTESIANPOINT((0.,0.,0.));\n'],
      [5, 'IFCAXIS2PLACEMENT3D', '#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n'],
      [7, 'IFCCONNECTIONPOINTECCENTRICITY', '#7=IFCCONNECTIONPOINTECCENTRICITY($,$,$,$,10.);\n'],
      [6, 'IFCRELCONNECTSWITHECCENTRICITY', "#6=IFCRELCONNECTSWITHECCENTRICITY('0rel00000000000000000',$,$,$,#1,#2,$,$,$,#5,#7);\n"],
    ]);

    const result = new StepExporter(store).export({ schema: 'IFC4', includeGeometry: false });
    const content = decode(result.content);

    expect(findDanglingRefs(content)).toEqual([]);
    expect(content).not.toContain('#6=IFCRELCONNECTSWITHECCENTRICITY');
    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain('#6');
  });

  it('control: the same store with geometry INCLUDED keeps the relationship', () => {
    // Without this, the test above would also pass if the exporter had simply
    // stopped writing `IFCRELCONNECTSSTRUCTURALMEMBER` altogether.
    const result = new StepExporter(buildStructuralConnectionStore().store).export({ schema: 'IFC4' });
    const content = decode(result.content);

    expect(content).toContain('#5=IFCAXIS2PLACEMENT3D');
    expect(content).toContain('#6=IFCRELCONNECTSSTRUCTURALMEMBER');
    expect(findDanglingRefs(content)).toEqual([]);
    expect(result.stats.warnings).toEqual([]);
  });
});

describe('the relationship filter runs when a source ref is unreadable', () => {
  it('drops an unreadable wall from the containment relation on a PLAIN export', () => {
    // The fourth disjunct, and the reason #2668 exists. The behaviour is
    // pinned in depth by `unreadable-ref-dangling.test.ts`; this case is here
    // so the gate's four rows are all stated in one place — delete the
    // unreadable-ref disjunct and this reds alongside that file.
    const { store, byId } = buildTwoWallStore();
    const ref = byId.get(2)!;
    ref.byteLength = store.source!.byteLength - ref.byteOffset + 64;

    const content = decode(new StepExporter(store).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#2=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('scans the COMPLETE index: an unreadable record in deferredEntityIndex counts', () => {
    // The one disjunct with an implementation to get wrong, and this is the
    // way to get it wrong: scanning `entityIndex.byId` is cheaper, obvious,
    // and blind to the secondary index `getCompleteEntityIndex` exists to
    // merge in. Executed both ways — `byId` leaves the gate false and ships
    // `#2` dangling; the complete index does not.
    //
    // The pairing is deliberate rather than observed: `deferPropertyAtomIndex`
    // defers property ATOMS only (`PROPERTY_CONTAINER_TYPES` keeps every
    // container in `byId`), and no `IFCREL*` names an atom directly, so this
    // exact store is not one today's parser emits. `deferredEntityIndex` is a
    // public part of `IfcDataStore` that the transport round-trips verbatim,
    // and the gate's obligation is over the id space `isOmittedFromOutput`
    // answers for — which is the merged one. Pinning the scope behaviourally
    // is what stops the cheaper scan being reintroduced as an optimisation.
    const { store, byId } = buildParsedStore([
      [1, 'IFCWALL', WALL_A],
      [2, 'IFCWALL', WALL_B],
      [3, 'IFCBUILDINGSTOREY', STOREY],
      [4, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', CONTAINMENT],
    ]);
    const ref = byId.get(2)!;
    ref.byteLength = store.source!.byteLength - ref.byteOffset + 64;

    // Move `#2` out of the primary index and into the deferred one, leaving
    // every other record and every byte offset exactly where it was.
    byId.delete(2);
    (store as { deferredEntityIndex?: Map<number, MockEntityRef> }).deferredEntityIndex =
      new Map([[2, ref]]);

    const content = decode(new StepExporter(store).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#2=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });
});
