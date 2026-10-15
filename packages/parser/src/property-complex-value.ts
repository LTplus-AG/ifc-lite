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

/*
 * The walk's bounds and markers mirror `ifc_lite_core::limits` exactly (#7675):
 * the server's data model and the Rust STEP exporter take them from there, and
 * one shared vector (`test/fixtures/complex-property-budget-7675.json`) pins all
 * three walks to the same value for the same file.
 */

/** `MAX_COMPLEX_PROPERTY_DEPTH`: how deep a `HasProperties` walk descends. */
const MAX_COMPLEX_PROPERTY_DEPTH = 8;

/** `MAX_COMPLEX_PROPERTY_MEMBERS`: member reads per top-level property. The
 *  depth cap bounds a path's LENGTH only; a member listing itself `k` times is
 *  `k^8` reads. Output accumulates, so a work budget, not a visited set. */
const MAX_COMPLEX_PROPERTY_MEMBERS = 1024;

/** `COMPLEX_PROPERTY_OUTPUT_BYTES`: UTF-8 bytes of complex-property text one
 *  `extractPsetsFromIds` call may build. Visits alone do not bound bytes: one
 *  visit can copy a long name, and a set can list one complex property many
 *  times (one 10 KB name cost 269 MB of heap, #7675). */
export const COMPLEX_PROPERTY_OUTPUT_BYTES = 1 << 20;

/**
 * `complex_property_depth_marker()`: appended when the depth cap stops the walk
 * with `HasProperties` members still unread (issue #3972). A suffix rather than
 * a `truncated` flag: a flag is silently lost at any one of the `Property`
 * type, the `serverDataModel` adapter, the Rust struct + serde, the parquet
 * columns and the panel renderer; the value string reaches every reader.
 */
function complexPropertyTruncationMarker(): string {
    return `(truncated: nesting deeper than ${MAX_COMPLEX_PROPERTY_DEPTH} levels)`;
}

/** `COMPLEX_PROPERTY_BUDGET_MARKER`: a level cut by the budget is its parts so
 *  far, then this. The usage name is not repeated. */
const COMPLEX_PROPERTY_BUDGET_MARKER = '(truncated: nested properties over the walk budget)';

/** UTF-8 length, so the byte budget charges what the Rust walks charge. */
function utf8Length(text: string): number {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit < 0x80) bytes += 1;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
            bytes += 4;
            i++;
        } else bytes += 3;
    }
    return bytes;
}

/**
 * `ComplexPropertyBudget`: member visits for the current top-level property and
 * output bytes for the whole scope it was created for. Check order, identical
 * in every copy: {@link ComplexPropertyBudget.admitMember} before reading a
 * member, {@link ComplexPropertyBudget.charge} a built `"Name: value"` part,
 * then charge a level's joined value.
 */
export class ComplexPropertyBudget {
    private visits = 0;
    private bytesLeft: number;

    constructor(outputBytes: number = COMPLEX_PROPERTY_OUTPUT_BYTES) {
        this.bytesLeft = outputBytes;
    }

    /** Start a top-level property: visits restart, bytes carry on. */
    startProperty(): void {
        this.visits = 0;
    }

    /** Whether one more member may be read, counting it if so. */
    admitMember(): boolean {
        if (this.visits >= MAX_COMPLEX_PROPERTY_MEMBERS || this.bytesLeft === 0) return false;
        this.visits += 1;
        return true;
    }

    /** Charge built text by its UTF-8 length. */
    charge(text: string): void {
        this.bytesLeft = Math.max(0, this.bytesLeft - utf8Length(text));
    }
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
 *
 * `budget` cuts a level that runs out with its parts so far plus
 * {@link COMPLEX_PROPERTY_BUDGET_MARKER}; pass the caller's scope (one per
 * `extractPsetsFromIds` call), or a fresh one is used.
 */
export function resolveComplexPropertyValue(
    store: IfcDataStore,
    extractor: EntityExtractor,
    propEntity: IfcEntity,
    budget: ComplexPropertyBudget = new ComplexPropertyBudget()
): ParsedIfcPropertyValue {
    budget.startProperty();
    return resolveComplex(store, extractor, propEntity, 0, budget);
}

function resolveComplex(
    store: IfcDataStore,
    extractor: EntityExtractor,
    propEntity: IfcEntity,
    depth: number,
    budget: ComplexPropertyBudget
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
    let outOfBudget = false;

    for (const ref of hasProperties) {
        if (typeof ref !== 'number') continue;
        if (!budget.admitMember()) {
            outOfBudget = true;
            break;
        }
        // @raw-entity-enumeration-ok complex-property parsing follows this source member reference, not an entity set
        const nestedRef = store.entityIndex.byId.get(ref) ?? store.deferredEntityIndex?.get(ref);
        if (!nestedRef) continue;
        const nestedEntity = extractor.extractEntity(nestedRef);
        if (!nestedEntity) continue;

        const nestedAttrs = nestedEntity.attributes || [];
        const nestedName = typeof nestedAttrs[0] === 'string' ? nestedAttrs[0] : '';
        const nestedParsed = nestedEntity.type.toUpperCase() === 'IFCCOMPLEXPROPERTY'
            ? resolveComplex(store, extractor, nestedEntity, depth + 1, budget)
            : parsePropertyValueWithComplex(store, extractor, nestedEntity, budget);
        if (nestedName) {
            const unit = resolvePropertyUnit(store, extractor, nestedEntity.type, nestedAttrs, nestedParsed.dataType);
            members.push({
                name: nestedName,
                ...nestedParsed,
                ...(unit ? { unit: unit.symbol } : {}),
                ...(unit?.siScale !== undefined ? { unitSiScale: unit.siScale } : {}),
                ...(unit?.siOffset !== undefined ? { unitSiOffset: unit.siOffset } : {}),
            });
        }

        const display = nestedParsed.value != null ? String(nestedParsed.value) : '';
        if (!display) continue;
        const part = nestedName ? `${nestedName}: ${display}` : display;
        budget.charge(part);
        parts.push(part);
        values.push(display);
    }

    let value: string | null;
    if (parts.length === 0) {
        value = outOfBudget ? COMPLEX_PROPERTY_BUDGET_MARKER : (usageName || null);
    } else {
        const joined = parts.join(', ');
        value = outOfBudget ? `${joined} ${COMPLEX_PROPERTY_BUDGET_MARKER}` : joined;
        budget.charge(value);
    }
    return {
        type: PropertyValueType.String,
        value,
        structure: 'complex',
        ...(values.length > 0 ? { values } : {}),
        ...(members.length > 0 ? { members } : {}),
    };
}
