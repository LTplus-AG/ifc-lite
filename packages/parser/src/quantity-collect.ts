/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared reader for an `IfcElementQuantity.Quantities` list (#3254).
 *
 * The instance path (`ColumnarParser.extractQuantitiesOnDemand`) and the type
 * path (`extractQsetsFromIds`) both walk that list, and each used to inline its
 * own copy of the walk — two copies that would disagree the moment either was
 * touched. The walk lives here and both call it.
 */

import { QuantityType } from '@ifc-lite/data';
import type { EntityRef } from './types.js';
import type { EntityExtractor } from './entity-extractor.js';
import { QUANTITY_TYPE_MAP } from './columnar-parser-indexes.js';

/** One extracted quantity, in the shape both call sites report. */
export interface CollectedQuantity {
    name: string;
    type: number;
    value: number;
}

/**
 * The part of `IfcDataStore` this walk needs, declared structurally so the
 * module need not import `IfcDataStore` from `columnar-parser.ts`, which
 * imports this file back.
 */
export interface QuantityLookupStore {
    entityIndex: { byId: { get(id: number): EntityRef | undefined } };
    deferredEntityIndex?: { get(id: number): EntityRef | undefined };
}

/**
 * `IfcPhysicalComplexQuantity` groups other quantities instead of carrying a
 * value of its own (`packages/codegen/schemas/IFC4_ADD2_TC1.exp`, identically
 * in `IFC4X3.exp`):
 *
 *     ENTITY IfcPhysicalComplexQuantity
 *      SUBTYPE OF (IfcPhysicalQuantity);
 *         HasQuantities : SET [1:?] OF IfcPhysicalQuantity;
 *         Discrimination : IfcLabel;
 *         Quality : OPTIONAL IfcLabel;
 *         Usage : OPTIONAL IfcLabel;
 *
 * With `Name` and `Description` inherited from `IfcPhysicalQuantity`, the
 * flattened slots are HasQuantities[2], Discrimination[3], Quality[4],
 * Usage[5]. Slot 3 — where every `IfcPhysicalSimpleQuantity` subtype keeps its
 * measure — therefore holds a label here.
 */
const COMPLEX_QUANTITY_TYPE = 'IFCPHYSICALCOMPLEXQUANTITY';

/**
 * Value slot on every `IfcPhysicalSimpleQuantity` subtype: Name[0],
 * Description[1], Unit[2], *Value[3].
 */
const SIMPLE_QUANTITY_VALUE_SLOT = 3;

/**
 * Read an `IfcElementQuantity.Quantities` list into flat quantity records.
 *
 * An `IfcPhysicalComplexQuantity` is skipped: it has no measure to report, and
 * a `{name, type, value}` triple has nowhere to put its `HasQuantities`
 * children. Before #3254 it fell through the simple-quantity path and surfaced
 * as a phantom `Count = 0` — a row that satisfied IDS existence requirements,
 * counted as "has quantities" in `validate`, entered the compare fingerprints
 * and rendered as a bogus quantity card. Skipping matches what the legacy
 * `quantity-extractor.ts` already does for a type it does not recognise, so all
 * three quantity readers now agree.
 *
 * **Its nested quantities are dropped with it, and that is a known gap with no
 * tracking issue behind it.** Not "tracked separately" — an earlier version of
 * this comment said so and nothing tracked it. A set whose only member is a
 * complex quantity therefore reports no quantities at all: on the fixture in
 * #3254, two `IfcQuantityArea` children totalling 26 m² read back as nothing.
 *
 * The gap is deliberate rather than overlooked. Flattening the children into
 * this list would feed new names to a dozen name-keyed consumers, and — via the
 * mutable property view that re-writes a touched `IfcElementQuantity` from these
 * records, and `step-property-sets.ts` which emits them as flat siblings — would
 * permanently destroy the complex structure on the next export. Surfacing them
 * safely needs a representation these records do not have: one that read-side
 * consumers can see and the write-back path provably skips. Until that exists,
 * under-reporting is the lesser harm, and this paragraph is the whole of what
 * anyone is doing about it.
 *
 * An entity of a type absent from {@link QUANTITY_TYPE_MAP} still reports as a
 * `Count`, keeping its value under a wrong label rather than vanishing. No
 * `IfcPhysicalSimpleQuantity` subtype relies on that fallback today —
 * `IfcQuantityNumber` (IFC4X3) did until #3266 gave it `QuantityType.Number`,
 * and `test/quantity-type-map-coverage.test.ts` now reds if a schema declares a
 * subtype the map has not gained.
 */
export function collectQuantitiesFromRefs(
    store: QuantityLookupStore,
    extractor: EntityExtractor,
    refs: unknown,
): CollectedQuantity[] {
    const quantities: CollectedQuantity[] = [];
    if (!Array.isArray(refs)) return quantities;

    for (const qtyRef of refs) {
        if (typeof qtyRef !== 'number') continue;

        const qtyEntityRef = store.entityIndex.byId.get(qtyRef) ?? store.deferredEntityIndex?.get(qtyRef);
        if (!qtyEntityRef) continue;

        const qtyEntity = extractor.extractEntity(qtyEntityRef);
        if (!qtyEntity) continue;

        const qtyTypeUpper = qtyEntity.type.toUpperCase();
        if (qtyTypeUpper === COMPLEX_QUANTITY_TYPE) continue;

        const qtyAttrs = qtyEntity.attributes || [];
        const qtyName = typeof qtyAttrs[0] === 'string' ? qtyAttrs[0] : '';
        if (!qtyName) continue;

        const qtyType = QUANTITY_TYPE_MAP[qtyTypeUpper] ?? QuantityType.Count;
        const rawValue = qtyAttrs[SIMPLE_QUANTITY_VALUE_SLOT];
        const value = typeof rawValue === 'number' ? rawValue : 0;

        quantities.push({ name: qtyName, type: qtyType, value });
    }

    return quantities;
}
