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
import { isUnrepresentableNumericValue } from './attribute-helpers.js';
import { resolveUnitByRef, type ProjectUnits } from './project-units.js';

/** One extracted quantity, in the shape both call sites report. */
export interface CollectedQuantity {
    name: string;
    type: number;
    value: number;
    /** SI factor of this quantity's explicit `Unit`, when it declares one.
     *  An omitted unit inherits the project's unit assignment. */
    explicitUnitSiScale?: number;
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
 * this comment said so and nothing tracked it. The children are lost in every
 * case — #3254's fixture nests two `IfcQuantityArea` totalling 26 m² that read
 * back as nothing — and a set whose ONLY member is a complex quantity collects
 * nothing, so since #3261 {@link readQuantitySet} drops the whole
 * `IfcElementQuantity` rather than reporting an empty one.
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
 * subtype the map has not gained. That test guards the OTHER hand-written set
 * too: `PROPERTY_ENTITY_TYPES` in `columnar-parser-indexes.ts` decides whether
 * the entity is retained at all, so a subtype missing THERE never reaches this
 * map and the quantity does not exist rather than being mislabelled.
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
        // `IfcPhysicalSimpleQuantity.Unit` is optional, but it overrides the
        // project assignment when present. Preserve its scale on the record so
        // every downstream reader of this shared collection uses the same
        // physical value rather than silently treating (say) 2000 mm as 2000 m.
        const unitRef = qtyAttrs[2];
        const unit = typeof unitRef === 'number'
            ? resolveUnitByRef(extractor, store.entityIndex, unitRef)
            : null;
        const rawValue = qtyAttrs[SIMPLE_QUANTITY_VALUE_SLOT];

        // A measure the double range cannot hold is dropped with a diagnostic,
        // not reported as `0`. `CollectedQuantity.value` is `number` and is
        // consumed by callers that do arithmetic on it, so there is no
        // in-band way to say "unrepresentable" — and `0` is the worst of the
        // available lies, because a 0 m^3 volume reads as a measurement
        // somebody took. An absent quantity is detectable; a zero one is not.
        //
        // This matches what the sibling path already does:
        // `QuantityExtractor.extractQuantity` returns `null` and warns when
        // slot 3 is not a number. That path and this one walk the same
        // `Quantities` list, so they must agree.
        //
        // The diagnostic is per occurrence, deliberately. Each line names a
        // different entity id and quantity name, so it is the list of what was
        // dropped rather than one message repeated — collapsing it to
        // once-per-file would leave a reader knowing that something was
        // discarded and not which. There is also no per-file context threaded
        // through this function to hang a once-per-file flag on: the only
        // place to keep one is module scope, which outlives a file in the
        // viewer's long-lived worker and would then silence the *next* file's
        // first warning. No `console.warn` in this package is throttled
        // today, so a local cap here would be the one-off. The cost is bounded by how
        // corrupt the file is, and a file with thousands of unrepresentable
        // measures has a louder problem than its console output.
        if (isUnrepresentableNumericValue(rawValue)) {
            console.warn(
                `[quantity-collect] ${qtyEntity.type} #${qtyEntity.expressId} "${qtyName}" ` +
                `has a value outside the IEEE-754 double range (${String(rawValue)}); ` +
                `dropping the quantity rather than reporting it as 0.`,
            );
            continue;
        }

        const value = typeof rawValue === 'number' ? rawValue : 0;

        quantities.push({
            name: qtyName,
            type: qtyType,
            value,
            ...(unit ? { explicitUnitSiScale: unit.resolved.siScale } : {}),
        });
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
 * an unresolvable reference, an `IfcPhysicalComplexQuantity` (#3254), or a
 * measure outside the IEEE-754 double range — is non-conformant data. Reporting it anyway would assert "this element has
 * quantities" on the strength of a name alone, and the consumers act on exactly
 * that: `validate` counts the element as quantified in its quantity-completeness
 * figure, an IDS quantity-set existence check passes, and the viewer's fallback
 * to the element's TYPE quantities is suppressed by the phantom occurrence set,
 * hiding the real numbers the type carries. So it is dropped (#3259).
 *
 * That applies unchanged when every member was dropped for being
 * unrepresentable: the set then vanishes rather than surviving empty. Keeping
 * an empty shell would make exactly the claim #3259 removed — "this element is
 * quantified" — while carrying no number to back it, and it would still
 * suppress the type-quantity fallback. The reason each quantity went is on the
 * console; the reason the set went is that nothing in it survived.
 *
 * The instance path and the type path both go through here, so the drop cannot
 * come apart between them again: it used to be inlined at each site, and the
 * type site dropped while the instance site kept.
 */
export function readQuantitySet(
    store: QuantityLookupStore,
    extractor: EntityExtractor,
    qsetRef: EntityRef,
): CollectedQuantitySet | null {
    const qsetEntity = extractor.extractEntity(qsetRef);
    if (!qsetEntity) return null;

    const qsetAttrs = qsetEntity.attributes || [];
    // Left empty rather than a fabricated `QuantitySet #<id>` when the source
    // declared no Name: this is `store.getQuantities()`'s answer, consumed
    // verbatim downstream (MCP tool responses, `bim.quantities()`) as though
    // the model had genuinely declared that name (#3530 census).
    const qsetName = typeof qsetAttrs[2] === 'string' ? qsetAttrs[2] : '';
    const quantities = collectQuantitiesFromRefs(store, extractor, qsetAttrs[QUANTITIES_SLOT]);

    if (quantities.length === 0) return null;
    return { name: qsetName, quantities };
}

/**
 * SI scale factor for a `Qto_` value, preferring its explicit `Unit` and then
 * resolving against the project's declared units.
 *
 * An `IfcQuantityLength`/`Area`/`Volume` is stored in the project's raw
 * author unit exactly like an `IfcPropertySingleValue` of the matching
 * measure type — the value is not pre-converted to SI by the exporter. A
 * consumer that hashes or otherwise compares `CollectedQuantity.value`
 * across two files (or against a base-SI literal) as-is therefore reads a
 * project's choice of length unit as a change in the design itself: the
 * same 2 m wall authored in millimetres carries the raw value `2000`
 * instead of `2`.
 *
 * `1` for `Count`/`Weight`/`Time`/`Number` — this only scales the three
 * quantity types that are themselves `IfcLengthMeasure`-family measures.
 *
 * Area and Volume scale by the SQUARE and CUBE of the length factor (a
 * millimetre-authored 1 m² is stored as `1e6`, not `1e3`) — but only as a
 * FALLBACK: `IFC` lets a project declare an explicit `AREAUNIT`/`VOLUMEUNIT`
 * with no arithmetic relationship to `LENGTHUNIT`, so the file's own
 * declaration is preferred and the length-derived power is used only when
 * the project declares none. An explicit member `Unit` always wins; IFC uses
 * it specifically to let a quantity depart from its containing project's
 * assignment.
 */
export function quantitySiScale(quantity: CollectedQuantity, units: ProjectUnits): number {
    if (quantity.explicitUnitSiScale !== undefined) return quantity.explicitUnitSiScale;

    switch (quantity.type) {
        case QuantityType.Length:
            return units.unitForMeasure('IfcLengthMeasure')?.siScale ?? 1;
        case QuantityType.Area: {
            const explicit = units.resolvedForUnitType('AREAUNIT')?.siScale;
            if (explicit !== undefined) return explicit;
            const length = units.unitForMeasure('IfcLengthMeasure')?.siScale ?? 1;
            return length ** 2;
        }
        case QuantityType.Volume: {
            const explicit = units.resolvedForUnitType('VOLUMEUNIT')?.siScale;
            if (explicit !== undefined) return explicit;
            const length = units.unitForMeasure('IfcLengthMeasure')?.siScale ?? 1;
            return length ** 3;
        }
        default:
            return 1;
    }
}
