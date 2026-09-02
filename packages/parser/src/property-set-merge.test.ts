/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { appendSetsFromSecondSource, setIdentityKey } from './property-set-merge.js';

/**
 * Regression coverage for #3722: `appendSetsFromSecondSource` is the shared
 * helper behind `extractTypePropertiesOnDemand`, `extractTypeEntityOwnProperties`
 * and `extractTypeQuantitiesOnDemand` (see `on-demand-extractors.ts`). It backs
 * onto the type's `HasPropertySets` attribute as the first source and the
 * `IfcRelDefinesByProperties` map as the second, and must keep two distinct
 * `IfcElementQuantity`/`IfcPropertySet` instances apart even when they share a
 * literal name -- the same defect shape #3603 and #3606 fixed for the
 * occurrence-level `PropertyTable`/`QuantityTable`.
 */
interface Set_ {
    name: string;
    globalId?: string;
    quantities: string[];
}

function set(name: string, globalId: string, ...quantities: string[]): Set_ {
    return { name, globalId, quantities };
}

describe('appendSetsFromSecondSource', () => {
    it('keeps two distinct same-named instances separate (RED for #3722)', () => {
        const firstSourceSet = set('Qto_X', '1QSW1i7cmDDeutJc0G3Q3l', 'Length=5');
        const into: Set_[] = [firstSourceSet];
        const firstSourceIds = new Set<number>([100]);
        const firstSourceKeys = new Set<string>([setIdentityKey(firstSourceSet)]);
        const candidateIds = [200]; // distinct express id, reachable via IfcRelDefinesByProperties

        appendSetsFromSecondSource(
            into,
            firstSourceIds,
            firstSourceKeys,
            candidateIds,
            (ids) => {
                expect(ids).toEqual([200]);
                return [set('Qto_X', '2XyZ9a8bcDDeutJc0G3Q3l', 'Width=7')];
            },
        );

        expect(into).toHaveLength(2);
        expect(into.map((s) => s.globalId).sort()).toEqual(
            ['1QSW1i7cmDDeutJc0G3Q3l', '2XyZ9a8bcDDeutJc0G3Q3l'].sort(),
        );
    });

    it('leaves a genuine single set unchanged when nothing fresh is found', () => {
        const firstSourceSet = set('Qto_X', '1QSW1i7cmDDeutJc0G3Q3l', 'Length=5');
        const into: Set_[] = [firstSourceSet];
        const firstSourceIds = new Set<number>([100]);
        const firstSourceKeys = new Set<string>([setIdentityKey(firstSourceSet)]);

        appendSetsFromSecondSource(into, firstSourceIds, firstSourceKeys, [100], () => {
            throw new Error('extract must not run when every candidate id is already in firstSourceIds');
        });

        expect(into).toHaveLength(1);
    });

    it('still merges two rows of the SAME instance (same name and GlobalId)', () => {
        const firstSourceSet = set('Qto_X', '1QSW1i7cmDDeutJc0G3Q3l', 'Length=5');
        const into: Set_[] = [firstSourceSet];
        const firstSourceIds = new Set<number>([100]);
        const firstSourceKeys = new Set<string>([setIdentityKey(firstSourceSet)]);
        // A candidate id that is fresh (not in firstSourceIds) but resolves to
        // the SAME name+GlobalId as the first-source entry -- e.g. the same
        // qset reachable via both HasPropertySets and IfcRelDefinesByProperties
        // under two different express ids for some malformed/duplicated export.
        const candidateIds = [300];

        appendSetsFromSecondSource(into, firstSourceIds, firstSourceKeys, candidateIds, () => [
            set('Qto_X', '1QSW1i7cmDDeutJc0G3Q3l', 'Length=5-duplicate'),
        ]);

        expect(into).toHaveLength(1);
    });
});
