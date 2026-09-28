/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcComplexProperty` decoding. Split out of `property-value-parser.ts` for
 * the module-size budget; `parsePropertyValueWithComplex` there dispatches
 * here, and each nested member is decoded back through it.
 */

import type { IfcEntity } from './types.js';
import type { EntityExtractor } from './entity-extractor.js';
import { PropertyValueType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { resolvePropertyUnit } from './property-unit.js';
import {
    parsePropertyValueWithComplex,
    type ExtractedProperty,
    type ParsedIfcPropertyValue,
} from './property-value-parser.js';

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
 * nested `IfcComplexProperty`. Without this, `parsePropertyValue`'s
 * default branch reads attribute index 2 as if it were a `NominalValue`,
 * which for `IfcComplexProperty` is `UsageName` — a label, not a value — and
 * every nested property silently vanishes from the panel/query output.
 *
 * `members` keeps each nested property by its own `Name`, decoded the same
 * way and with its own explicit unit, so a rule's `memberPath` can address
 * one member (#5475).
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
    const members: ExtractedProperty[] = [];

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
        if (nestedName) {
            const unit = resolvePropertyUnit(store, extractor, nestedEntity.type, nestedAttrs, nestedParsed.dataType);
            members.push({
                name: nestedName,
                ...nestedParsed,
                ...(unit ? { unit: unit.symbol } : {}),
                ...(unit?.siScale !== undefined ? { unitSiScale: unit.siScale } : {}),
            });
        }

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
        ...(members.length > 0 ? { members } : {}),
    };
}
