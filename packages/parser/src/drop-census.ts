/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Semantic drop census (#4208).
 *
 * The TypeScript parser categorises every scanned STEP record into one of a
 * fixed set of buckets (`columnar-parser.ts`'s `CAT_*` constants). Anything
 * that lands in `CAT_SKIP` never enters the `EntityTable`, the property
 * graph, or the relationship graph — it is retrievable by expressId (it is
 * still indexed in `byType`/`byId`) but semantically invisible everywhere
 * else. Nothing previously counted how many records fell into that bucket,
 * or which classes they were, so a schema-registry gap (a new IFC4x3 class,
 * a vendor extension, a typo'd keyword) silently disappeared with no signal
 * anywhere in the loader.
 *
 * This module turns the per-record category the parser already computes
 * into a report: how many records were scanned per class, how many were
 * retained, which classes were skipped, which classes weren't even
 * recognised by the schema registry, and which `IFCREL*` classes were seen
 * on the wire but never routed into a relationship-graph bucket.
 *
 * `buildDropCensus` is a pure function over already-collected counts so it
 * can be unit-tested without parsing a real file, and so a completed parse
 * can never fail to attach one silently: the caller either has counts (and
 * calls this) or has nothing to report (and must say so explicitly, not by
 * omission) — see `IfcDataStore.dropCensus` in `columnar-parser.ts`.
 */

/** The parser's semantic retention categories, as stable string labels. */
export type DropCategory =
    | 'skip'
    | 'spatial'
    | 'geometry'
    | 'hierarchy-rel'
    | 'property-rel'
    | 'property-entity'
    | 'association-rel'
    | 'type-object'
    | 'relevant'
    | 'group';

export interface ClassCensusEntry {
    /** Uppercase STEP keyword, e.g. `IFCWALL`. */
    type: string;
    /** Records of this class encountered while scanning the file. */
    scanned: number;
    /** Records of this class that entered a downstream table/graph (0 for `skip`). */
    retained: number;
    category: DropCategory;
    /** Whether the type is recognised by the bundled IFC2X3/IFC4/IFC4X3 schema registry. */
    knownInSchema: boolean;
    /**
     * Whether the type's EXPRESS inheritance chain includes `IfcRoot` — i.e.
     * whether instances of this class carry a `GlobalId` and are addressable
     * as first-class entities. Geometry/placement/style resource classes
     * (`IfcCartesianPoint`, `IfcAxis2Placement3D`, `IfcIndexedPolygonalFace`,
     * …) are never `IfcRoot` descendants and are *expected* to fall to
     * `CAT_SKIP` on every real IFC file — tessellated geometry alone can
     * outnumber every other record in the file. An `IfcRoot` descendant
     * falling to `CAT_SKIP` is a different story: it has an identity the
     * model author gave it, and dropping it is the kind of regression this
     * census exists to catch (see the `skipped-class` vs
     * `skipped-class-expected` split this field drives in
     * `@ifc-lite/mcp`'s `validation.ts` and `@ifc-lite/cli`'s `info.ts`).
     */
    isRootDescendant: boolean;
}

export interface DropCensus {
    /**
     * Always `true` when this object exists. Distinguishes "the census ran
     * and found nothing" (an object with `ran: true`, `totalScanned > 0`,
     * empty drop lists) from "the census never ran" (the field is absent) —
     * callers must check for the field's presence, not just its contents.
     */
    ran: true;
    totalScanned: number;
    totalRetained: number;
    totalSkipped: number;
    /** Every class seen, scanned-count descending. */
    byClass: ClassCensusEntry[];
    /** Subset of `byClass` with category `skip`. */
    skippedClasses: ClassCensusEntry[];
    /**
     * Subset of `skippedClasses` that are NOT `IfcRoot` descendants — records
     * with no `GlobalId` (geometry, placement, and style resources). This
     * bucket fires on essentially every real IFC file and is not, by itself,
     * evidence of a problem.
     */
    expectedSkippedClasses: ClassCensusEntry[];
    /**
     * Subset of `skippedClasses` that ARE `IfcRoot` descendants — a class
     * with its own identity (`GlobalId`) that nonetheless never entered the
     * entity table. This is the subset worth alarming on: it is the shape of
     * the #4208 `IfcCovering`-fell-out-of-`GEOMETRY_TYPES` incident
     * (documented in `columnar-entity-preparation.ts`), not universal
     * tessellation noise.
     */
    unexpectedSkippedClasses: ClassCensusEntry[];
    /** Subset of `byClass` not recognised by the schema registry at all. */
    unknownClasses: ClassCensusEntry[];
    /** Count of distinct `IFCREL*` classes seen on the wire. */
    relClassesSeen: number;
    /** Count of distinct `IFCREL*` classes routed into a relationship-graph bucket. */
    relClassesIndexed: number;
    /** `IFCREL*` classes seen but never indexed as a relationship-graph edge. */
    unindexedRelClasses: ClassCensusEntry[];
}

export interface DropCensusInput {
    /** Records scanned, keyed by uppercase STEP type. */
    scannedByType: Map<string, number>;
    /** Retention category assigned to each uppercase STEP type. */
    categoryByType: Map<string, DropCategory>;
    /** Whether each uppercase STEP type is known to the schema registry. */
    knownByType: Map<string, boolean>;
    /**
     * Whether each uppercase STEP type's inheritance chain includes
     * `IfcRoot`. Drives the `expectedSkippedClasses` /
     * `unexpectedSkippedClasses` split — see {@link ClassCensusEntry.isRootDescendant}.
     */
    rootDescendantByType: Map<string, boolean>;
    /**
     * Uppercase STEP types the categoriser explicitly intends to retain
     * even though they are not `IfcProduct`/`IfcRoot` descendants — e.g.
     * `columnar-entity-preparation.ts`'s `RELEVANT_NON_PRODUCT_HELPERS`
     * (`IFCMATERIAL`, `IFCSIUNIT`, `IFCCLASSIFICATION`, …). None of these
     * reach `IfcRoot` in the schema's inheritance chain, so on
     * `isRootDescendant` alone a regression that dropped one of them from
     * that set would compute `isRootDescendant: false` and land in
     * `expectedSkippedClasses` at `info` severity — indistinguishable from
     * routine geometry/placement noise. Membership here means "the code
     * intends to retain this class regardless of root-descendancy", so a
     * skip is `unexpectedSkippedClasses` regardless of that check. Passing
     * the set the categoriser already maintains (rather than a second,
     * separately-hand-maintained list here) keeps the two in sync by
     * construction.
     */
    alwaysRelevantTypes: Set<string>;
    /** Distinct `IFCREL*` uppercase types seen. */
    relSeenTypes: Set<string>;
    /** Distinct `IFCREL*` uppercase types seen but not indexed as an edge. */
    relUnindexedTypes: Set<string>;
}

/**
 * Build a `DropCensus` from counts collected during a parse. Pure and
 * total: an empty `scannedByType` produces a census with `totalScanned: 0`
 * and empty lists — still `ran: true` — rather than throwing or returning
 * nothing, so "examined zero records" is always reported honestly.
 */
export function buildDropCensus(input: DropCensusInput): DropCensus {
    const byClass: ClassCensusEntry[] = [];
    let totalScanned = 0;
    let totalSkipped = 0;

    for (const [type, scanned] of input.scannedByType) {
        const category = input.categoryByType.get(type) ?? 'skip';
        const retained = category === 'skip' ? 0 : scanned;
        totalScanned += scanned;
        if (category === 'skip') totalSkipped += scanned;
        byClass.push({
            type,
            scanned,
            retained,
            category,
            knownInSchema: input.knownByType.get(type) ?? false,
            isRootDescendant: input.rootDescendantByType.get(type) ?? false,
        });
    }
    byClass.sort((a, b) => b.scanned - a.scanned || a.type.localeCompare(b.type));

    const skippedClasses = byClass.filter(c => c.category === 'skip');
    // A class is "unexpected" if it's an IfcRoot descendant OR the
    // categoriser explicitly intends to retain it (alwaysRelevantTypes) —
    // see the field doc on DropCensusInput.alwaysRelevantTypes.
    const expectedSkippedClasses = skippedClasses.filter(
        c => !c.isRootDescendant && !input.alwaysRelevantTypes.has(c.type),
    );
    const unexpectedSkippedClasses = skippedClasses.filter(
        c => c.isRootDescendant || input.alwaysRelevantTypes.has(c.type),
    );
    const unknownClasses = byClass.filter(c => !c.knownInSchema);
    const unindexedRelClasses = byClass.filter(c => input.relUnindexedTypes.has(c.type));

    return {
        ran: true,
        totalScanned,
        totalRetained: totalScanned - totalSkipped,
        totalSkipped,
        byClass,
        skippedClasses,
        expectedSkippedClasses,
        unexpectedSkippedClasses,
        unknownClasses,
        relClassesSeen: input.relSeenTypes.size,
        relClassesIndexed: input.relSeenTypes.size - input.relUnindexedTypes.size,
        unindexedRelClasses,
    };
}
