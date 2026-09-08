/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `QUANTITY_TYPE_MAP` must cover every `IfcPhysicalSimpleQuantity` subtype the
 * bundled schemas declare (#3254, #3266).
 *
 * The map is hand-written, and `collectQuantitiesFromRefs` reads it as
 * `QUANTITY_TYPE_MAP[type] ?? QuantityType.Count`. A subtype missing from it
 * does not fail — it is relabelled a `Count`, keeping its value under the wrong
 * name. That is exactly what happened to `IfcQuantityNumber`, which IFC4X3
 * added and the map did not gain until #3266: the STEP exporter rewrote the
 * entity to `IFCQUANTITYCOUNT` on round-trip and the Parquet column read
 * `Count`.
 *
 * `@ifc-lite/data`'s `quantity-type-completeness.test.ts` guards the
 * `QuantityType` ENUM against the generated entity tables. This guards the
 * parser's STEP-keyword LOOKUP against the EXPRESS schemas — the other half of
 * the same join, and the half that was silently short.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QuantityType } from '@ifc-lite/data';
import { QUANTITY_TYPE_MAP, PROPERTY_ENTITY_TYPES } from '../src/columnar-parser-indexes.js';

const SCHEMA_DIR = fileURLToPath(new URL('../../codegen/schemas/', import.meta.url));

/**
 * Every entity declared `SUBTYPE OF (IfcPhysicalSimpleQuantity)` in one
 * schema, as its uppercase STEP keyword.
 */
function simpleQuantitySubtypes(schemaFile: string): string[] {
    const exp = readFileSync(SCHEMA_DIR + schemaFile, 'utf8');
    return [...exp.matchAll(/^ENTITY (\w+)\s*\n\s*SUBTYPE OF \(IfcPhysicalSimpleQuantity\);/gm)].map((m) =>
        m[1].toUpperCase(),
    );
}

/**
 * Anti-vacuity guard: a NAMED list, not a count floor. Every one of these is
 * declared in at least one bundled schema, so a regex that stopped matching —
 * the failure mode a `length > 0` floor cannot see — reds here by name.
 */
const REQUIRED_SUBTYPES = [
    'IFCQUANTITYAREA',
    'IFCQUANTITYCOUNT',
    'IFCQUANTITYLENGTH',
    'IFCQUANTITYNUMBER',
    'IFCQUANTITYTIME',
    'IFCQUANTITYVOLUME',
    'IFCQUANTITYWEIGHT',
];

const schemaFiles = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.exp'));

describe('QUANTITY_TYPE_MAP covers the IfcPhysicalSimpleQuantity family (#3254)', () => {
    it('finds the schemas it claims to read', () => {
        // Both directions of the fixture premise: the files exist, and the two
        // this suite reasons about are among them.
        expect(schemaFiles).toContain('IFC4_ADD2_TC1.exp');
        expect(schemaFiles).toContain('IFC4X3.exp');
    });

    it.each(schemaFiles)('%s declares subtypes the scan can see', (schemaFile) => {
        const found = simpleQuantitySubtypes(schemaFile);
        // Named, not counted: IFCQUANTITYLENGTH is in every schema that
        // declares the supertype at all, so a broken regex cannot pass here.
        expect(found).toContain('IFCQUANTITYLENGTH');
        expect(found).toContain('IFCQUANTITYAREA');
    });

    it('declares the union the required list names, and no more', () => {
        const union = [...new Set(schemaFiles.flatMap(simpleQuantitySubtypes))].sort();
        // Direction 1: nothing the schemas declare is missing from the list.
        // Direction 2: nothing on the list has stopped being declared. An
        // equality assertion carries both, so a schema regeneration that adds
        // or removes a subtype reds instead of drifting past.
        expect(union).toEqual([...REQUIRED_SUBTYPES].sort());
    });

    it('maps every declared subtype to a distinct QuantityType', () => {
        const union = [...new Set(schemaFiles.flatMap(simpleQuantitySubtypes))].sort();

        const unmapped = union.filter((kw) => !(kw in QUANTITY_TYPE_MAP));
        expect(
            unmapped,
            `these IfcPhysicalSimpleQuantity subtypes fall through to QuantityType.Count and would ` +
                `be relabelled on export: ${unmapped.join(', ')}. Add a QuantityType member and a ` +
                `QUANTITY_TYPE_MAP row (see #3266).`,
        ).toEqual([]);

        // The reverse direction: no key in the map that no schema declares.
        // Such a row is dead weight at best and a misreading at worst.
        expect([...Object.keys(QUANTITY_TYPE_MAP)].sort()).toEqual(union);

        // Distinct: two subtypes sharing one QuantityType would make the STEP
        // round-trip pick the wrong keyword for one of them.
        const values = union.map((kw) => QUANTITY_TYPE_MAP[kw]);
        expect(new Set(values).size).toBe(values.length);
    });

    it('pins IfcQuantityNumber to Number, not Count', () => {
        // The specific regression #3266 fixed. Asserted against the enum member
        // rather than the literal 6, and against Count in the negative, so a
        // renumbering of the enum cannot make this vacuously true.
        expect(QUANTITY_TYPE_MAP['IFCQUANTITYNUMBER']).toBe(QuantityType.Number);
        expect(QUANTITY_TYPE_MAP['IFCQUANTITYNUMBER']).not.toBe(QuantityType.Count);
    });

    it('PROPERTY_ENTITY_TYPES admits every declared subtype, or it is never parsed', () => {
        // The OTHER hand-written set, and the earlier one: `getCategory` in
        // columnar-parser.ts consults PROPERTY_ENTITY_TYPES to decide whether
        // an entity is a property entity AT ALL. A subtype missing there is
        // never retained, so QUANTITY_TYPE_MAP is never consulted for it and a
        // map row for it is unreachable — the quantity simply does not exist.
        //
        // This is not hypothetical: removing 'IFCQUANTITYNUMBER' from
        // PROPERTY_ENTITY_TYPES alone left every parser test green while
        // IFC4X3's IfcQuantityNumber became silently unparseable. Two sets that
        // must agree, with only one of them guarded, is how the first gap got
        // here.
        const union = [...new Set(schemaFiles.flatMap(simpleQuantitySubtypes))].sort();

        const unadmitted = union.filter((kw) => !PROPERTY_ENTITY_TYPES.has(kw));
        expect(
            unadmitted,
            `these IfcPhysicalSimpleQuantity subtypes are declared by a bundled schema but are ` +
                `not in PROPERTY_ENTITY_TYPES, so the parser discards the entity before any ` +
                `quantity is read from it: ${unadmitted.join(', ')}`,
        ).toEqual([]);

        // The two sets must agree on the quantity family in BOTH directions:
        // a PROPERTY_ENTITY_TYPES row for a quantity keyword with no
        // QUANTITY_TYPE_MAP entry parses the entity and then relabels it Count.
        const admittedQuantities = [...PROPERTY_ENTITY_TYPES]
            .filter((kw) => kw.startsWith('IFCQUANTITY'))
            .sort();
        expect(admittedQuantities).toEqual(union);
    });

    it('negative control: non-simple and unknown keywords are absent', () => {
        // IfcPhysicalComplexQuantity is a sibling of IfcPhysicalSimpleQuantity,
        // not a subtype. It carries no measure, so a row here would resurrect
        // the phantom `Count = 0` #3254 removed.
        expect(simpleQuantitySubtypes('IFC4X3.exp')).not.toContain('IFCPHYSICALCOMPLEXQUANTITY');
        expect('IFCPHYSICALCOMPLEXQUANTITY' in QUANTITY_TYPE_MAP).toBe(false);
        // A keyword no schema declares must not be matched by the scan either.
        expect(simpleQuantitySubtypes('IFC4X3.exp')).not.toContain('IFCQUANTITYACME');
        expect('IFCQUANTITYACME' in QUANTITY_TYPE_MAP).toBe(false);
    });
});
