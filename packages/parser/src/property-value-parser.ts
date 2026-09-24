/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property VALUE parsing for the on-demand STEP extraction path: decodes a
 * single `IfcProperty` subtype entity (IfcPropertySingleValue,
 * IfcPropertyEnumeratedValue, IfcPropertyBoundedValue, IfcPropertyListValue,
 * IfcPropertyTableValue, IfcPropertyReferenceValue, IfcComplexProperty) into
 * the `{ type, value, values?, dataType? }` shape the property panel/query
 * layer consumes. Split out of on-demand-extractors.ts to stay under the
 * module-size budget.
 */

import type { IfcEntity } from './types.js';
import type { EntityExtractor } from './entity-extractor.js';
import { PropertyValueType } from '@ifc-lite/data';
import type { PropertyValue } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { resolvePropertyReferenceValue } from './property-reference-value.js';

// ============================================================================
// Property Value Parsing Helpers
// ============================================================================

/** One decoded `IfcProperty`. `dataType` is the IFC type of the value (for a
 *  list or enumeration, the one type all members share). `dataTypeMixed`
 *  marks an `IfcPropertyTableValue`, whose columns carry different types by
 *  design, so no single `dataType` exists (#5224). */
export interface ParsedIfcPropertyValue {
    type: number;
    value: PropertyValue;
    values?: string[];
    dataType?: string;
    dataTypeMixed?: true;
    /**
     * Which `IfcProperty` subtype carried the value, when it is not a single
     * value. `values` then holds the candidates a rule reads: every member of
     * an enumerated or list value, every cell of a table (#5475).
     */
    structure?: 'enumerated' | 'bounded' | 'list' | 'table' | 'reference' | 'complex';
}

/** One property as the on-demand extractors return it: the parsed value
 *  plus its name and, when the file declares one, its explicit unit. */
export interface ExtractedProperty extends ParsedIfcPropertyValue {
    name: string;
    unit?: string;
    unitSiScale?: number;
}

/** The IFC type every typed member of a list shares, or `undefined` when a
 *  member is untyped or the types differ. */
function sharedMemberType(members: unknown[]): string | undefined {
    let shared: string | undefined;
    for (const m of members) {
        if (!Array.isArray(m) || m.length !== 2) return undefined;
        const t = String(m[0]).toUpperCase();
        if (shared !== undefined && shared !== t) return undefined;
        shared = t;
    }
    return shared;
}

/**
 * Parse a property entity's value based on its IFC type.
 * Handles all 6 IfcProperty subtypes:
 * - IfcPropertySingleValue: direct value
 * - IfcPropertyEnumeratedValue: list of enum values → joined string
 * - IfcPropertyBoundedValue: upper/lower bounds → "value [min – max]"
 * - IfcPropertyListValue: list of values → joined string
 * - IfcPropertyTableValue: defining/defined value pairs → "Table(N rows)"
 * - IfcPropertyReferenceValue: entity reference → "Reference #ID"
 */
export function parsePropertyValue(propEntity: IfcEntity): ParsedIfcPropertyValue {
    const attrs = propEntity.attributes || [];
    const typeUpper = propEntity.type.toUpperCase();

    switch (typeUpper) {
        case 'IFCPROPERTYENUMERATEDVALUE': {
            // [Name, Description, EnumerationValues (list), EnumerationReference]
            const enumValues = attrs[2];
            if (Array.isArray(enumValues)) {
                const values = enumValues.map(v => {
                    if (Array.isArray(v) && v.length === 2) return String(v[1]); // Typed value
                    return String(v);
                }).filter(v => v !== 'null' && v !== 'undefined');
                // Surface the raw value list separately so IDS facet
                // checks can iterate "any matching value passes". The
                // joined display string remains the primary `value`
                // for visualisation/property-table consumers.
                const dataType = sharedMemberType(enumValues);
                return { type: 0, value: values.join(', ') || null, values, structure: 'enumerated', ...(dataType ? { dataType } : {}) };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYBOUNDEDVALUE': {
            // [Name, Description, UpperBoundValue, LowerBoundValue, Unit, SetPointValue]
            const upper = extractNumericValue(attrs[2]);
            const lower = extractNumericValue(attrs[3]);
            const setPoint = extractNumericValue(attrs[5]);
            const displayValue = setPoint ?? upper ?? lower;
            let display = displayValue != null ? String(displayValue) : '';
            if (lower != null && upper != null) {
                display += ` [${lower} – ${upper}]`;
            }
            // Surface every defined bound as a candidate value — IDS
            // bounded-property checks pass when ANY of the bounds /
            // setpoint matches the constraint, per upstream ifctester.
            const candidates: string[] = [];
            if (lower != null) candidates.push(String(lower));
            if (upper != null && upper !== lower) candidates.push(String(upper));
            if (setPoint != null && setPoint !== lower && setPoint !== upper) {
                candidates.push(String(setPoint));
            }
            // Carry the IFC-declared measure tag so the IDS-side data
            // type comparison and unit conversion both work.
            const inferDataType = (attr: unknown): string | undefined => {
                if (Array.isArray(attr) && attr.length === 2) {
                    return String(attr[0]).toUpperCase();
                }
                return undefined;
            };
            const dataType =
                inferDataType(attrs[5]) ||
                inferDataType(attrs[2]) ||
                inferDataType(attrs[3]);
            return {
                type: displayValue != null ? 1 : 0,
                value: display || null,
                structure: 'bounded',
                ...(candidates.length > 0 ? { values: candidates } : {}),
                ...(dataType ? { dataType } : {}),
            };
        }

        case 'IFCPROPERTYLISTVALUE': {
            // [Name, Description, ListValues (list), Unit]
            const listValues = attrs[2];
            if (Array.isArray(listValues)) {
                const values = listValues.map(v => {
                    if (Array.isArray(v) && v.length === 2) return String(v[1]);
                    return String(v);
                }).filter(v => v !== 'null' && v !== 'undefined');
                const dataType = sharedMemberType(listValues);
                return { type: 0, value: values.join(', ') || null, values, structure: 'list', ...(dataType ? { dataType } : {}) };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYTABLEVALUE': {
            // [Name, Description, DefiningValues, DefinedValues, ...]
            const definingValues = attrs[2];
            const definedValues = attrs[3];
            const rowCount = Array.isArray(definingValues) ? definingValues.length : 0;
            if (rowCount > 0 && Array.isArray(definedValues) && Array.isArray(definingValues)) {
                // Surface both defining and defined values as candidate
                // matches — IDS table-value checks pass when ANY entry
                // matches the constraint (per upstream ifctester).
                const stringify = (v: unknown): string => {
                    if (Array.isArray(v) && v.length === 2) return String(v[1]);
                    return String(v);
                };
                const values = [
                    ...definingValues.map(stringify),
                    ...definedValues.map(stringify),
                ].filter(v => v !== 'null' && v !== 'undefined');
                // Tables mix types per column (label / length / …), so
                // there is no single dataType. Say so explicitly: an IDS
                // dataType check then falls through to a value match
                // against the candidates, as upstream ifctester does. An
                // absent dataType anywhere else means "unknown" and fails
                // such a check (#5224).
                return {
                    type: 0,
                    value: `Table (${rowCount} rows)`,
                    values,
                    dataTypeMixed: true,
                    structure: 'table',
                };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYREFERENCEVALUE': {
            // [Name, Description, UsageName, PropertyReference]. Without a
            // store the referenced object cannot be read, so only its id is
            // known; `parsePropertyValueWithComplex` reads its Name (#5475).
            const refValue = attrs[3];
            return typeof refValue === 'number'
                ? { type: 0, value: `#${refValue}`, structure: 'reference' }
                : { type: 0, value: null, structure: 'reference' };
        }

        default: {
            // IfcPropertySingleValue and fallback: [Name, Description, NominalValue, Unit]
            const nominalValue = attrs[2];
            let type: number = PropertyValueType.String;
            let value: PropertyValue = nominalValue as PropertyValue;
            let dataType: string | undefined;

            // Handle typed values like IFCBOOLEAN(.T.), IFCREAL(1.5)
            if (Array.isArray(nominalValue) && nominalValue.length === 2) {
                const innerValue = nominalValue[1];
                const typeName = String(nominalValue[0]).toUpperCase();
                dataType = typeName;

                if (typeName.includes('BOOLEAN')) {
                    type = PropertyValueType.Boolean;
                    value = innerValue === '.T.' || innerValue === true;
                } else if (typeName.includes('LOGICAL')) {
                    type = PropertyValueType.Logical;
                    // Preserve .U. (unknown) as null; .T./.F. as boolean
                    if (innerValue === '.U.' || innerValue === '.X.') {
                        value = null;
                    } else {
                        value = innerValue === '.T.' || innerValue === true;
                    }
                } else if (typeof innerValue === 'number') {
                    // Preserve the IFC-declared numeric measure (IFCREAL,
                    // IFCINTEGER, IFCLENGTHMEASURE, IFCAREAMEASURE, …) —
                    // the source explicitly tagged the value, so don't
                    // re-infer from JS number-ness (which would
                    // misclassify e.g. `IFCREAL(0.0)` as integer).
                    if (typeName === 'IFCINTEGER' || typeName === 'IFCCOUNTMEASURE') {
                        type = PropertyValueType.Integer;
                    } else if (
                        typeName === 'IFCREAL' ||
                        typeName.endsWith('MEASURE') ||
                        typeName.endsWith('RATIO')
                    ) {
                        type = PropertyValueType.Real;
                    } else if (Number.isInteger(innerValue)) {
                        type = PropertyValueType.Integer;
                    } else {
                        type = PropertyValueType.Real;
                    }
                    value = innerValue;
                } else {
                    type = PropertyValueType.String;
                    value = String(innerValue);
                }
            } else if (typeof nominalValue === 'number') {
                type = Number.isInteger(nominalValue) ? PropertyValueType.Integer : PropertyValueType.Real;
            } else if (typeof nominalValue === 'boolean') {
                type = PropertyValueType.Boolean;
            } else if (nominalValue !== null && nominalValue !== undefined) {
                // Normalize untagged STEP enumeration tokens. Conformant IFC wraps
                // booleans as IFCBOOLEAN(.T.) (handled above), but some authoring
                // tools emit the bare tokens directly in the NominalValue slot.
                if (nominalValue === '.T.') {
                    type = PropertyValueType.Boolean;
                    value = true;
                } else if (nominalValue === '.F.') {
                    type = PropertyValueType.Boolean;
                    value = false;
                } else if (nominalValue === '.U.' || nominalValue === '.X.') {
                    type = PropertyValueType.Logical;
                    value = null;
                } else {
                    value = String(nominalValue);
                }
            }

            return { type, value, ...(dataType ? { dataType } : {}) };
        }
    }
}

/** Extract a numeric value from a possibly typed STEP value. */
export function extractNumericValue(attr: unknown): number | null {
    if (typeof attr === 'number') return attr;
    if (Array.isArray(attr) && attr.length === 2 && typeof attr[1] === 'number') return attr[1];
    return null;
}

/** Guards {@link resolveComplexPropertyValue} against a pathological/cyclic
 *  HasProperties chain; real IFC nests IfcComplexProperty at most a couple of
 *  levels deep (e.g. Pset "sub-properties"). */
const MAX_COMPLEX_PROPERTY_DEPTH = 8;

/**
 * The suffix minted into a complex property's display value when
 * {@link MAX_COMPLEX_PROPERTY_DEPTH} stops the walk with `HasProperties`
 * members still unread (issue #3972). Byte-identical to
 * `complex_property_truncation_marker()` in
 * `apps/server/src/services/data_model/property_value.rs` — the two paths
 * feed the same property panel, CSV/parquet export and compare fingerprints,
 * so a divergence here reads as a data difference between browser and server.
 *
 * A suffix rather than a `truncated` flag on `Property`: a flag would have to
 * be carried through the `Property` type, the `serverDataModel` adapter, the
 * Rust struct + serde, the per-field parquet columns and the panel renderer,
 * and is silently lost at any one of them — the same "a signal that never
 * fires" shape this issue is about. The value string reaches every reader by
 * construction.
 */
function complexPropertyTruncationMarker(): string {
    return `(truncated: nesting deeper than ${MAX_COMPLEX_PROPERTY_DEPTH} levels)`;
}

/**
 * Resolve an `IfcComplexProperty`'s nested `HasProperties` (EXPRESS:
 * `[Name, Description, UsageName, HasProperties]`, index 3) into a display
 * value plus a flat `values` candidate list, recursing into any further
 * nested `IfcComplexProperty`. Without this, {@link parsePropertyValue}'s
 * default branch reads attribute index 2 as if it were a `NominalValue`,
 * which for `IfcComplexProperty` is `UsageName` — a label, not a value — and
 * every nested property silently vanishes from the panel/query output.
 *
 * Hitting {@link MAX_COMPLEX_PROPERTY_DEPTH} with a non-empty `HasProperties`
 * still unread appends {@link complexPropertyTruncationMarker}; a bare
 * `UsageName` there is a plausible, well-formed value indistinguishable from
 * a complex property that genuinely has no nested content (issue #3972). The
 * empty-`UsageName` case matters most — before #3972 it produced an empty
 * display, the caller loop `continue`d past it, and the whole nested member
 * vanished while its parent fell back to showing its OWN `UsageName`, so the
 * reader saw a real value attributed to the wrong nesting level. An absent or
 * empty `HasProperties` is NOT a truncation and keeps the bare `UsageName`.
 */
export function resolveComplexPropertyValue(
    store: IfcDataStore,
    extractor: EntityExtractor,
    propEntity: IfcEntity,
    depth = 0
): ParsedIfcPropertyValue {
    const attrs = propEntity.attributes || [];
    const usageName = typeof attrs[2] === 'string' ? attrs[2] : '';
    const hasProperties = attrs[3];

    if (!Array.isArray(hasProperties) || hasProperties.length === 0) {
        // Nothing nested exists, so stopping here loses nothing and must NOT
        // be marked as a truncation.
        return { type: PropertyValueType.String, value: usageName || null };
    }

    if (depth >= MAX_COMPLEX_PROPERTY_DEPTH) {
        // Members were present and we declined to read them. Say so.
        const marker = complexPropertyTruncationMarker();
        return {
            type: PropertyValueType.String,
            value: usageName ? `${usageName} ${marker}` : marker,
        };
    }

    const parts: string[] = [];
    const values: string[] = [];

    for (const ref of hasProperties) {
        if (typeof ref !== 'number') continue;
        // @raw-entity-enumeration-ok complex-property parsing follows this source member reference, not an entity set
        const nestedRef = store.entityIndex.byId.get(ref) ?? store.deferredEntityIndex?.get(ref);
        if (!nestedRef) continue;
        const nestedEntity = extractor.extractEntity(nestedRef);
        if (!nestedEntity) continue;

        const nestedAttrs = nestedEntity.attributes || [];
        const nestedName = typeof nestedAttrs[0] === 'string' ? nestedAttrs[0] : '';
        const nestedParsed = nestedEntity.type.toUpperCase() === 'IFCCOMPLEXPROPERTY'
            ? resolveComplexPropertyValue(store, extractor, nestedEntity, depth + 1)
            : parsePropertyValueWithComplex(store, extractor, nestedEntity);

        const display = nestedParsed.value != null ? String(nestedParsed.value) : '';
        if (!display) continue;
        parts.push(nestedName ? `${nestedName}: ${display}` : display);
        values.push(display);
    }

    return {
        type: PropertyValueType.String,
        value: parts.length > 0 ? parts.join(', ') : (usageName || null),
        structure: 'complex',
        ...(values.length > 0 ? { values } : {}),
    };
}

/** Dispatch a pset member to {@link resolveComplexPropertyValue} for
 *  `IfcComplexProperty`, else the single-entity {@link parsePropertyValue}. */
export function parsePropertyValueWithComplex(
    store: IfcDataStore,
    extractor: EntityExtractor,
    propEntity: IfcEntity
): ParsedIfcPropertyValue {
    const type = propEntity.type.toUpperCase();
    if (type === 'IFCCOMPLEXPROPERTY') {
        return resolveComplexPropertyValue(store, extractor, propEntity);
    }
    if (type === 'IFCPROPERTYREFERENCEVALUE') {
        return resolvePropertyReferenceValue(store, extractor, propEntity);
    }
    return parsePropertyValue(propEntity);
}
