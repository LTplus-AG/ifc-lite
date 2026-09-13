/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for #4666: `EntityFlags.HAS_GEOMETRY` (and
 * `entities.hasGeometry()`) was set from the entity's CLASS BUCKET
 * (`GEOMETRY_TYPES` in columnar-parser-indexes.ts), not from whether the
 * entity's own `Representation` attribute is actually set. An
 * `IfcBuildingElementProxy` authored as a placement-only stub — attribute
 * order GlobalId, OwnerHistory, Name, Description, ObjectType,
 * ObjectPlacement, Representation, Tag, PredefinedType, so index 6 is
 * Representation — reported `hasGeometry() === true` even with
 * Representation `$`.
 *
 * Fixture shapes mirror the real corpus entities named in the issue
 * (tests/models/local/Building-Structural.ifc #162 and #196, gitignored;
 * reproduced inline here since the fixture itself cannot be committed).
 *
 * Three distinguishing cases (guards against a vacuous fixture where every
 * entity answers the same way):
 *  1. Representation `$`, own placement only -> false (the #162 shape).
 *  2. Representation set -> true.
 *  3. A container (IfcRoof-shaped) with Representation `$` that aggregates
 *     a geometry-bearing child via IfcRelAggregates -> the CONTAINER itself
 *     is false (aggregated children are not considered by this flag), while
 *     the AGGREGATED CHILD is independently true.
 *
 * #4725 review (CHANGES_REQUESTED): the fix above only reached
 * `geometryRefs` in columnar-parser.ts. `spatialRefs` and
 * `otherRelevantRefs` still called `addEntityBatch(refs, false, false)`
 * unconditionally, so an `IfcSite`/`IfcGrid`/etc. WITH its own
 * `Representation` set kept reporting `false` — a spatial/other-product
 * narrowing of the exact bug #4666 fixed. Two more distinguishing pairs
 * below exercise those two buckets specifically:
 *  4. `IfcSite` (spatialRefs) with Representation `$` -> false; the same
 *     class with Representation set -> true.
 *  5. `IfcProject` (also spatialRefs, but NOT an `IfcProduct` — its
 *     attribute index 6 is `Phase`, not `Representation`) always answers
 *     `false`, even though its index-6 byte value is not `$`. Proves the
 *     fix reads the SCHEMA's attribute name at that index rather than
 *     assuming every spatialRefs member has the same layout.
 *  6. `IfcGrid` (otherRelevantRefs, a real `IfcProduct` descendant in that
 *     bucket) with Representation `$` -> false; the same class with
 *     Representation set -> true.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';

function scan(ifc: string): { source: Uint8Array; entityRefs: EntityRef[] } {
    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs: EntityRef[] = [];
    for (const ref of tokenizer.scanEntitiesFast()) {
        entityRefs.push({
            expressId: ref.expressId,
            type: ref.type,
            byteOffset: ref.offset,
            byteLength: ref.length,
            lineNumber: ref.line,
        });
    }
    return { source, entityRefs };
}

// #162: IfcBuildingElementProxy with a placement (#165) and Representation `$`.
// #170: same class, WITH a Representation reference (#171) — the geometry-bearing twin.
// #196: IfcRoof (own Representation `$`) aggregating #197, an IfcBeam that DOES
// carry a Representation.
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#45=IFCAXIS2PLACEMENT3D($,$,$);
#165=IFCLOCALPLACEMENT($,#45);
#162=IFCBUILDINGELEMENTPROXY('1CjP_CWub368bZVuVHeHs3',#1,'Group#21',$,$,#165,$,'454425',$);
#170=IFCBUILDINGELEMENTPROXY('2CjP_CWub368bZVuVHeHs4',#1,'ProxyWithGeom',$,$,#165,#171,'tag2',$);
#171=IFCPRODUCTDEFINITIONSHAPE($,$,$);
#196=IFCROOF('3CjP_CWub368bZVuVHeHs5',#1,'Roof',$,$,#165,$,'tag3',$);
#197=IFCBEAM('4CjP_CWub368bZVuVHeHs6',#1,'Beam',$,$,#165,#171,'tag4',$);
#198=IFCRELAGGREGATES('5CjP_CWub368bZVuVHeHs7',#1,$,$,#196,(#197));
#300=IFCSITE('SiteNoRep0000000000001',#1,'Site',$,$,#165,$,$,.ELEMENT.,$,$,$,$,$);
#301=IFCSITE('SiteWithRep000000000001',#1,'SiteRep',$,$,#165,#171,$,.ELEMENT.,$,$,$,$,$);
#302=IFCPROJECT('Project00000000000000001',#1,'Proj',$,$,$,'Phase1',(#303),$);
#303=IFCGEOMETRICREPRESENTATIONCONTEXT($,$,3,$,#45,$);
#400=IFCGRID('GridNoRep00000000000001',#1,'Grid',$,$,#165,$,(),(),(),$);
#401=IFCGRID('GridWithRep0000000000001',#1,'GridRep',$,$,#165,#171,(),(),(),$);
`;

async function parseStore() {
    const { source, entityRefs } = scan(IFC);
    const parser = new ColumnarParser();
    return parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

describe('EntityTable.hasGeometry: own Representation attribute, not class bucket (#4666)', () => {
    it('is false for a class-bucket entity whose own Representation is $ (#162 shape)', async () => {
        const store = await parseStore();
        expect(store.entities.hasGeometry(162)).toBe(false);
    });

    it('is true for the same class when Representation is actually set', async () => {
        const store = await parseStore();
        expect(store.entities.hasGeometry(170)).toBe(true);
    });

    it('does not count geometry aggregated in via IfcRelAggregates', async () => {
        const store = await parseStore();
        // The container's own Representation is $: false, even though it
        // aggregates a geometry-bearing child. Distinguishes this flag from a
        // "does this id or its parts render anything" check.
        expect(store.entities.hasGeometry(196)).toBe(false);
        // The aggregated child answers independently and correctly true —
        // proves the fixture isn't vacuous (not every entity answers alike).
        expect(store.entities.hasGeometry(197)).toBe(true);
    });

    it('spatialRefs: is false for an IfcSite with Representation $, true when set', async () => {
        const store = await parseStore();
        expect(store.entities.hasGeometry(300)).toBe(false);
        expect(store.entities.hasGeometry(301)).toBe(true);
    });

    it('spatialRefs: an IfcProject (not an IfcProduct) is always false, regardless of its index-6 byte', async () => {
        const store = await parseStore();
        // #302's attribute index 6 is 'Phase1' — not $, and not empty — so a
        // fix that reads "index 6, is it $" for every spatialRefs member
        // would misread this as geometry-bearing. IfcProject's index 6 is
        // Phase, not Representation; it must answer false regardless.
        expect(store.entities.hasGeometry(302)).toBe(false);
    });

    it('otherRelevantRefs: is false for an IfcGrid with Representation $, true when set', async () => {
        const store = await parseStore();
        expect(store.entities.hasGeometry(400)).toBe(false);
        expect(store.entities.hasGeometry(401)).toBe(true);
    });
});
