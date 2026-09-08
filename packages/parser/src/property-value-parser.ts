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

// ============================================================================
// Property Value Parsing Helpers
// ============================================================================

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
export function parsePropertyValue(propEntity: IfcEntity): { type: number; value: PropertyValue; values?: string[]; dataType?: string } {
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
                return { type: 0, value: values.join(', ') || null, values };
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
                return { type: 0, value: values.join(', ') || null, values };
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
                // Tables mix types per column (label / length / …),
                // so we can't surface a single representative
                // dataType. Leaving it unset lets the IDS check fall
                // through to a pure value match against any of the
                // candidates — which is what upstream ifctester does
                // for table values.
                return {
                    type: 0,
                    value: `Table (${rowCount} rows)`,
                    values,
                };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYREFERENCEVALUE': {
            // [Name, Description, PropertyReference]
            const refValue = attrs[2];
            if (typeof refValue === 'number') {
                return { type: 0, value: `#${refValue}` };
            }
            return { type: 0, value: null };
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
 * Resolve an `IfcComplexProperty`'s nested `HasProperties` (EXPRESS:
 * `[Name, Description, UsageName, HasProperties]`, index 3) into a display
 * value plus a flat `values` candidate list, recursing into any further
 * nested `IfcComplexProperty`. Without this, {@link parsePropertyValue}'s
 * default branch reads attribute index 2 as if it were a `NominalValue`,
 * which for `IfcComplexProperty` is `UsageName` — a label, not a value — and
 * every nested property silently vanishes from the panel/query output.
 */
export function resolveComplexPropertyValue(
    store: IfcDataStore,
    extractor: EntityExtractor,
    propEntity: IfcEntity,
    depth = 0
): { type: number; value: PropertyValue; values?: string[]; dataType?: string } {
    const attrs = propEntity.attributes || [];
    const usageName = typeof attrs[2] === 'string' ? attrs[2] : '';
    const hasProperties = attrs[3];

    if (!Array.isArray(hasProperties) || depth >= MAX_COMPLEX_PROPERTY_DEPTH) {
        return { type: PropertyValueType.String, value: usageName || null };
    }

    const parts: string[] = [];
    const values: string[] = [];

    for (const ref of hasProperties) {
        if (typeof ref !== 'number') continue;
        const nestedRef = store.entityIndex.byId.get(ref) ?? store.deferredEntityIndex?.get(ref);
        if (!nestedRef) continue;
        const nestedEntity = extractor.extractEntity(nestedRef);
        if (!nestedEntity) continue;

        const nestedAttrs = nestedEntity.attributes || [];
        const nestedName = typeof nestedAttrs[0] === 'string' ? nestedAttrs[0] : '';
        const nestedParsed = nestedEntity.type.toUpperCase() === 'IFCCOMPLEXPROPERTY'
            ? resolveComplexPropertyValue(store, extractor, nestedEntity, depth + 1)
            : parsePropertyValue(nestedEntity);

        const display = nestedParsed.value != null ? String(nestedParsed.value) : '';
        if (!display) continue;
        parts.push(nestedName ? `${nestedName}: ${display}` : display);
        values.push(display);
    }

    return {
        type: PropertyValueType.String,
        value: parts.length > 0 ? parts.join(', ') : (usageName || null),
        ...(values.length > 0 ? { values } : {}),
    };
}

/** Dispatch a pset member to {@link resolveComplexPropertyValue} for
 *  `IfcComplexProperty`, else the single-entity {@link parsePropertyValue}. */
export function parsePropertyValueWithComplex(
    store: IfcDataStore,
    extractor: EntityExtractor,
    propEntity: IfcEntity
): { type: number; value: PropertyValue; values?: string[]; dataType?: string } {
    if (propEntity.type.toUpperCase() === 'IFCCOMPLEXPROPERTY') {
        return resolveComplexPropertyValue(store, extractor, propEntity);
    }
    return parsePropertyValue(propEntity);
}
