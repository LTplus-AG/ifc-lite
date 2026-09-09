/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the semantic drop census (#4208): a load that
 * silently drops a class must show up in `store.dropCensus`, and a load
 * with nothing dropped must report that honestly (zero drops, not "did not
 * run").
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, type IfcDataStore } from '../src/columnar-parser.js';
import { buildDropCensus } from '../src/drop-census.js';

async function parseSource(ifc: string): Promise<IfcDataStore> {
    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs = [];
    for (const ref of tokenizer.scanEntitiesFast()) {
        entityRefs.push({
            expressId: ref.expressId,
            type: ref.type,
            byteOffset: ref.offset,
            byteLength: ref.length,
            lineNumber: ref.line,
        });
    }
    const parser = new ColumnarParser();
    return (await parser.parseLite(source.buffer.slice(0), entityRefs, {})) as IfcDataStore;
}

describe('drop census (#4208)', () => {
    it('names a class the categoriser falls to CAT_SKIP for', async () => {
        // IFCPERSON is a real, schema-known IFC4 entity that is not spatial,
        // not geometry, not a relationship, not an IfcProduct/IfcGroup
        // subtype, and not IFCREL* — it categorises as CAT_SKIP today. It
        // must show up in the census, not disappear silently.
        const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#2=IFCPERSON($,'Doe','John',$,$,$,$,$);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);`;

        const store = await parseSource(ifc);
        expect(store.dropCensus?.ran).toBe(true);
        const census = store.dropCensus!;

        expect(census.totalScanned).toBe(3);
        // Both IFCOWNERHISTORY and IFCPERSON fall to CAT_SKIP here (neither
        // is spatial/geometry/relationship/product/group), leaving only the
        // wall retained. Pinned as an exact count, not >=1: mutating
        // `totalRetained: totalScanned - totalSkipped` to
        // `totalRetained: totalScanned` would report 3, not 1, and this
        // assertion is the only place in the suite that would catch it.
        expect(census.totalSkipped).toBe(2);
        expect(census.totalRetained).toBe(1);

        const person = census.skippedClasses.find(c => c.type === 'IFCPERSON');
        expect(person).toBeDefined();
        expect(person!.scanned).toBe(1);
        expect(person!.retained).toBe(0);
        expect(person!.category).toBe('skip');
        expect(person!.knownInSchema).toBe(true);

        // IFCPERSON has no GlobalId and is not an IfcRoot descendant — it is
        // an *expected* skip (a resource record), not the kind of drop this
        // census exists to alarm on.
        expect(person!.isRootDescendant).toBe(false);
        expect(census.expectedSkippedClasses.some(c => c.type === 'IFCPERSON')).toBe(true);
        expect(census.unexpectedSkippedClasses.some(c => c.type === 'IFCPERSON')).toBe(false);

        // The wall is retained and must not appear in skippedClasses.
        expect(census.skippedClasses.some(c => c.type === 'IFCWALLSTANDARDCASE')).toBe(false);
        const wall = census.byClass.find(c => c.type === 'IFCWALLSTANDARDCASE');
        expect(wall!.retained).toBe(1);
    });

    it('flags a keyword the schema registry does not recognise', async () => {
        const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#2=IFCNOTAREALIFCTYPE('bogus');`;
        const store = await parseSource(ifc);
        const census = store.dropCensus!;
        const bogus = census.unknownClasses.find(c => c.type === 'IFCNOTAREALIFCTYPE');
        expect(bogus).toBeDefined();
        expect(bogus!.knownInSchema).toBe(false);
    });

    it('reports an IFCREL* class seen but not indexed as a relationship edge', async () => {
        // IFCRELASSIGNSTOPROCESS is a real IFCREL* keyword that is not in
        // HIERARCHY_REL_TYPES/PROPERTY_REL_TYPES/ASSOCIATION_REL_TYPES, so it
        // is seen (and stays addressable via byType) but is never routed
        // into the relationship graph as an edge.
        const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#2=IFCRELASSIGNSTOPROCESS('rel-guid',#1,$,$,$,$,$,$);`;
        const store = await parseSource(ifc);
        const census = store.dropCensus!;
        expect(census.relClassesSeen).toBeGreaterThanOrEqual(1);
        const rel = census.unindexedRelClasses.find(c => c.type === 'IFCRELASSIGNSTOPROCESS');
        expect(rel).toBeDefined();

        // Exactly one IFCREL* class was seen and it was NOT indexed, so
        // relClassesIndexed must be 0. Pinned as an exact value: mutating
        // `relClassesIndexed: input.relSeenTypes.size - input.relUnindexedTypes.size`
        // to `relClassesIndexed: input.relSeenTypes.size` would report 1
        // instead of 0, and no other assertion in this suite reads the field.
        expect(census.relClassesSeen).toBe(1);
        expect(census.relClassesIndexed).toBe(0);
    });

    it('reports zero drops honestly (not the same shape as "did not run")', async () => {
        // IFCOWNERHISTORY itself is CAT_SKIP (it's a bookkeeping entity, not
        // a spatial/geometry/relationship/product/group class) — a real
        // finding this same census surfaces, not a bug in the fixture. To
        // exercise the genuine zero-drop path the fixture below references
        // no OwnerHistory at all, so every scanned class is retained.
        const ifc = `#10=IFCWALLSTANDARDCASE('wall-guid',$,'Wall A',$,$,$,$,$);`;
        const store = await parseSource(ifc);
        const census = store.dropCensus;

        // The census must exist (it ran) even though it found nothing to
        // report — that is what distinguishes "zero drops" from "no census".
        expect(census).toBeDefined();
        expect(census!.ran).toBe(true);
        expect(census!.totalScanned).toBe(1);
        expect(census!.totalSkipped).toBe(0);
        expect(census!.skippedClasses).toEqual([]);
        expect(census!.unknownClasses).toEqual([]);
    });

    it('splits skippedClasses into expected (no GlobalId) vs unexpected (IfcRoot descendant)', () => {
        // Pure unit test of buildDropCensus's own split logic, independent of
        // which real IFC classes the parser currently routes to CAT_SKIP.
        const census = buildDropCensus({
            scannedByType: new Map([
                ['IFCCARTESIANPOINT', 5],
                ['IFCSURPRISINGLYDROPPEDPRODUCT', 2],
            ]),
            categoryByType: new Map([
                ['IFCCARTESIANPOINT', 'skip'],
                ['IFCSURPRISINGLYDROPPEDPRODUCT', 'skip'],
            ]),
            knownByType: new Map([
                ['IFCCARTESIANPOINT', true],
                ['IFCSURPRISINGLYDROPPEDPRODUCT', true],
            ]),
            rootDescendantByType: new Map([
                ['IFCCARTESIANPOINT', false],
                ['IFCSURPRISINGLYDROPPEDPRODUCT', true],
            ]),
            alwaysRelevantTypes: new Set(),
            relSeenTypes: new Set(),
            relUnindexedTypes: new Set(),
        });

        expect(census.skippedClasses.map(c => c.type).sort()).toEqual(
            ['IFCCARTESIANPOINT', 'IFCSURPRISINGLYDROPPEDPRODUCT'].sort(),
        );
        expect(census.expectedSkippedClasses.map(c => c.type)).toEqual(['IFCCARTESIANPOINT']);
        expect(census.unexpectedSkippedClasses.map(c => c.type)).toEqual(['IFCSURPRISINGLYDROPPEDPRODUCT']);
    });

    it('buildDropCensus is total over an empty input (never throws, still ran:true)', () => {
        const census = buildDropCensus({
            scannedByType: new Map(),
            categoryByType: new Map(),
            knownByType: new Map(),
            rootDescendantByType: new Map(),
            alwaysRelevantTypes: new Set(),
            relSeenTypes: new Set(),
            relUnindexedTypes: new Set(),
        });
        expect(census.ran).toBe(true);
        expect(census.totalScanned).toBe(0);
        expect(census.totalRetained).toBe(0);
        expect(census.byClass).toEqual([]);
        expect(census.expectedSkippedClasses).toEqual([]);
        expect(census.unexpectedSkippedClasses).toEqual([]);
    });

    it('surfaces a dropped alwaysRelevantTypes member as unexpected, not expected', () => {
        // Regression coverage for the blind spot in RELEVANT_NON_PRODUCT_HELPERS
        // (columnar-entity-preparation.ts): those 23 classes (IFCMATERIAL,
        // IFCSIUNIT, IFCCLASSIFICATION, IFCUNITASSIGNMENT, …) are retained by
        // explicit set membership, not by IfcRoot descendancy — none of them
        // reach IfcRoot in the schema's inheritance chain. Before this fix,
        // if one were ever accidentally dropped from that set (the same
        // regression class as the IfcCovering/GEOMETRY_TYPES incident this
        // module's docs describe), buildDropCensus would compute
        // isRootDescendant: false and file it under expectedSkippedClasses
        // at info severity, worded "as expected" — even though the
        // categoriser intends to always retain it. IFCMATERIAL here stands
        // in for any alwaysRelevantTypes member; isRootDescendant is false
        // exactly as it is for the real class, confirmed separately via
        // getInheritanceChain('IFCMATERIAL').includes('IFCROOT') === false.
        const census = buildDropCensus({
            scannedByType: new Map([['IFCMATERIAL', 4]]),
            categoryByType: new Map([['IFCMATERIAL', 'skip']]),
            knownByType: new Map([['IFCMATERIAL', true]]),
            rootDescendantByType: new Map([['IFCMATERIAL', false]]),
            alwaysRelevantTypes: new Set(['IFCMATERIAL']),
            relSeenTypes: new Set(),
            relUnindexedTypes: new Set(),
        });

        expect(census.skippedClasses.map(c => c.type)).toEqual(['IFCMATERIAL']);
        expect(census.unexpectedSkippedClasses.map(c => c.type)).toEqual(['IFCMATERIAL']);
        expect(census.expectedSkippedClasses).toEqual([]);
    });
});
