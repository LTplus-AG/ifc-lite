/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for identity loss on multi-line STEP records and
 * GEOMETRY_TYPES leaf-list drift (schependomlaan: picked IfcCovering showed
 * "IFCCOVERING / no GUID / STOREY #776514" instead of Name + GlobalId).
 *
 * Three compounding defects:
 *  1. getCategory() classified IfcCovering as CAT_RELEVANT (GEOMETRY_TYPES
 *     hardcoded leaf list omitted it) → skipped batchExtractGlobalIdAndName
 *     → empty GlobalId/Name in the columnar entity table.
 *  2. EntityExtractor.extractEntity() used /(.*)/ which doesn't cross
 *     newlines → returned null for ANY multi-line record (killed spatial
 *     names: "Storey #776514", and the on-demand attribute fallback).
 *  3. findQuotedAttrRange() skipped only space/tab before a quoted attr,
 *     not \n or \r → batch extraction returned null when an attribute
 *     started on a new source line (IFCCOVERINGTYPE names).
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { EntityExtractor } from '../src/entity-extractor.js';
import { findQuotedAttrRange } from '../src/columnar-parser-attributes.js';
import { GEOMETRY_TYPES } from '../src/columnar-parser-indexes.js';
import { getInheritanceChain } from '../src/ifc-schema.js';
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

// Multi-line records modeled on schependomlaan.ifc (covering #23896,
// storey #23569) — closing paren NOT on the first source line.
const MULTILINE_IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#23569=IFCBUILDINGSTOREY('0u4wgLe6n0ABVaiXyikbkA',#1,'00 begane grond',$,$,
#100,$,'00 begane grond',.ELEMENT.,0.);
#23896=IFCCOVERING('1s0bLlfMz1AuEn18W389Ww',#1,'buitenblad',
$,$,#200,#300,
'covering-tag',.CLADDING.);
#32000=IFCCOVERINGTYPE('2s0bLlfMz1AuEn18W389Ww',#1,
'binnenspouwblad type',$,$,$,$,$,$,.CLADDING.);`;

describe('multi-line STEP record identity (schependomlaan covering regression)', () => {
    it('parseLite stores GlobalId+Name for a multi-line IfcCovering (CAT_GEOMETRY, not CAT_RELEVANT)', async () => {
        const { source, entityRefs } = scan(MULTILINE_IFC);
        const parser = new ColumnarParser();
        const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});

        expect(store.entities.getGlobalId(23896)).toBe('1s0bLlfMz1AuEn18W389Ww');
        expect(store.entities.getName(23896)).toBe('buitenblad');
        // CAT_GEOMETRY classification (was CAT_RELEVANT → hasGeometry=false, no name extraction)
        expect(store.entities.hasGeometry(23896)).toBe(true);
    });

    it('parseLite stores the Name of a multi-line IfcBuildingStorey (no "Storey #id" fallback)', async () => {
        const { source, entityRefs } = scan(MULTILINE_IFC);
        const parser = new ColumnarParser();
        const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});

        expect(store.entities.getGlobalId(23569)).toBe('0u4wgLe6n0ABVaiXyikbkA');
        expect(store.entities.getName(23569)).toBe('00 begane grond');
    });

    it('parseLite extracts the Name of a type object whose Name attr starts on line 2', async () => {
        const { source, entityRefs } = scan(MULTILINE_IFC);
        const parser = new ColumnarParser();
        const store = await parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});

        expect(store.entities.getName(32000)).toBe('binnenspouwblad type');
    });

    it('EntityExtractor.extractEntity parses a record spanning multiple lines', () => {
        const { source, entityRefs } = scan(MULTILINE_IFC);
        const coveringRef = entityRefs.find(r => r.expressId === 23896)!;
        expect(coveringRef).toBeDefined();

        const entity = new EntityExtractor(source).extractEntity(coveringRef);
        expect(entity).not.toBeNull();
        expect(entity!.type.toUpperCase()).toBe('IFCCOVERING');
        expect(entity!.attributes[0]).toBe('1s0bLlfMz1AuEn18W389Ww');
        expect(entity!.attributes[2]).toBe('buitenblad');
        expect(entity!.attributes[7]).toBe('covering-tag');
    });

    it('findQuotedAttrRange finds a quoted attribute that starts after a newline', () => {
        const { source, entityRefs } = scan(MULTILINE_IFC);
        const typeRef = entityRefs.find(r => r.expressId === 32000)!;
        // Name (attr index 2) sits at the start of the second source line
        const range = findQuotedAttrRange(source, typeRef.byteOffset, typeRef.byteLength, 2);
        expect(range).not.toBeNull();
        const [start, end] = range!;
        const decoded = new TextDecoder().decode(source.subarray(start, end));
        expect(decoded).toBe('binnenspouwblad type');
    });
});

describe('GEOMETRY_TYPES covers every IfcElement subtype (schema-driven, no leaf drift)', () => {
    // getCategory() walks the inheritance chain against GEOMETRY_TYPES; with
    // IFCELEMENT in the set, every element leaf classifies as CAT_GEOMETRY.
    it.each([
        'IfcCovering', 'IfcChimney', 'IfcShadingDevice', 'IfcElementAssembly',
        'IfcTransportElement', 'IfcGeographicElement', 'IfcDistributionElement',
        'IfcEnergyConversionDevice', 'IfcFlowMovingDevice', 'IfcFlowStorageDevice',
    ])('%s inheritance chain hits GEOMETRY_TYPES', (type) => {
        const chain = getInheritanceChain(type).map(c => c.toUpperCase());
        expect(chain.some(ancestor => GEOMETRY_TYPES.has(ancestor))).toBe(true);
    });

    it('spatial types stay spatial: IfcSpace/IfcSite are not IfcElement subtypes', () => {
        for (const type of ['IfcSpace', 'IfcSite', 'IfcBuildingStorey']) {
            const chain = getInheritanceChain(type).map(c => c.toUpperCase());
            expect(chain).not.toContain('IFCELEMENT');
        }
    });
});
