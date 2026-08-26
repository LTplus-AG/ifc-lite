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
 * The nested quantities stay invisible, exactly as they are today; surfacing
 * them is tracked separately, because flattening them into this list would feed
 * new names to a dozen name-keyed consumers and — via the mutable property view
 * that re-writes a touched `IfcElementQuantity` from these records — would
 * flatten the complex structure out of the file on the next export.
 *
 * An entity of a type absent from {@link QUANTITY_TYPE_MAP} still reports as a
 * `Count`, which keeps `IfcQuantityNumber` (IFC4X3) surfacing its correct value
 * under a wrong label rather than vanishing; labelling it needs a new
 * `QuantityType` member and is tracked separately.
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

/**
 * `Quantities` slot on `IfcElementQuantity`: GlobalId[0], OwnerHistory[1],
 * Name[2], Description[3] inherited from `IfcRoot`, then MethodOfMeasurement[4]
 * and Quantities[5].
 */
const QUANTITIES_SLOT = 5;

/** One extracted quantity set, in the shape both call sites report. */
export interface CollectedQuantitySet {
    name: string;
    quantities: CollectedQuantity[];
}

/**
 * Read one `IfcElementQuantity` into a reportable quantity set, or `null` when
 * it carries nothing worth reporting.
 *
 * `IFC4_ADD2_TC1.exp` (identically `IFC4X3.exp`):
 *
 *     ENTITY IfcElementQuantity
 *      SUBTYPE OF (IfcQuantitySet);
 *         MethodOfMeasurement : OPTIONAL IfcLabel;
 *         Quantities : SET [1:?] OF IfcPhysicalQuantity;
 *
 * `SET [1:?]` admits no empty set, so a set that walks to zero quantities —
 * written empty, or filled only with members this reader cannot report, such as
 * an unresolvable reference or an `IfcPhysicalComplexQuantity` (#3254) — is
 * non-conformant data. Reporting it anyway would assert "this element has
 * quantities" on the strength of a name alone, and the consumers act on exactly
 * that: `validate` counts the element as quantified in its quantity-completeness
 * figure, an IDS quantity-set existence check passes, and the viewer's fallback
 * to the element's TYPE quantities is suppressed by the phantom occurrence set,
 * hiding the real numbers the type carries. So it is dropped (#3259).
 *
 * The instance path and the type path both go through here, so the drop cannot
 * come apart between them again: it used to be inlined at each site, and the
 * type site dropped while the instance site kept.
 */
export function readQuantitySet(
    store: QuantityLookupStore,
    extractor: EntityExtractor,
    qsetRef: EntityRef,
    qsetId: number,
): CollectedQuantitySet | null {
    const qsetEntity = extractor.extractEntity(qsetRef);
    if (!qsetEntity) return null;

    const qsetAttrs = qsetEntity.attributes || [];
    const qsetName = typeof qsetAttrs[2] === 'string' ? qsetAttrs[2] : `QuantitySet #${qsetId}`;
    const quantities = collectQuantitiesFromRefs(store, extractor, qsetAttrs[QUANTITIES_SLOT]);

    if (quantities.length === 0) return null;
    return { name: qsetName, quantities };
}
