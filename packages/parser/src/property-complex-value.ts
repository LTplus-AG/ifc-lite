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
 * The walk's bounds, markers and charges mirror `ifc_lite_core::limits` exactly
 * (#7675): the server's data model and the Rust STEP exporter take them from
 * there, and one shared vector (`test/fixtures/complex-property-budget-7675.json`)
 * pins all three walks to the same value for the same file.
 */

/** `MAX_COMPLEX_PROPERTY_DEPTH`: how deep a `HasProperties` walk descends. */
const MAX_COMPLEX_PROPERTY_DEPTH = 8;

/** `MAX_COMPLEX_PROPERTY_MEMBERS`: member reads per top-level property. The
 *  depth cap bounds a path's LENGTH only; a member listing itself `k` times is
 *  `k^8` reads. Output accumulates, so a work budget, not a visited set. */
const MAX_COMPLEX_PROPERTY_MEMBERS = 1024;

/** `COMPLEX_PROPERTY_OUTPUT_BYTES`: the floor of a model's output budget. */
export const COMPLEX_PROPERTY_OUTPUT_BYTES = 1 << 20;

/** `COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE`: what a model's complex properties
 *  may cost per source byte, above the floor. A first listing costs about
 *  three times what it keeps, a repeat listing only what it keeps; 16 keeps
 *  one 20-member property shared by 3 000 sets whole. */
const COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE = 16;

/** `COMPLEX_PROPERTY_MEMBER_BYTES`: a read member's `members` / `values` entry. */
const COMPLEX_PROPERTY_MEMBER_BYTES = 16;

/** `complex_property_output_budget`: ONE model's complex-property output, as
 *  UTF-8 bytes. The scope is the whole store (`complex-property-store.ts`):
 *  one budget per model, not per call, so no number of entities sharing a set
 *  multiplies it (one call per wall gave 2 GB of heap from 18.6 KB). */
export function complexPropertyOutputBudget(inputBytes: number): number {
    return Math.max(inputBytes * COMPLEX_PROPERTY_BYTES_PER_INPUT_BYTE, COMPLEX_PROPERTY_OUTPUT_BYTES);
}

/** `complex_property_listing_bytes`: what one listing of a resolved complex
 *  property keeps, its value and, per `values` entry, the entry and its text.
 *  A repeat listing is charged exactly this. */
export function complexPropertyListingBytes(value: string, values: readonly string[]): number {
    let bytes = utf8Length(value);
    for (const v of values) bytes += COMPLEX_PROPERTY_MEMBER_BYTES + utf8Length(v);
    return bytes;
}

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
 *  far, then this. The usage name is not repeated. A cut level's `values` end
 *  with it and its `members` with a member of this name and value, so a member
 *  past the cut reads as truncated, not absent (#7675 D3). */
export const COMPLEX_PROPERTY_BUDGET_MARKER = '(truncated: nested properties over the walk budget)';

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
 * `ComplexPropertyBudget`: member visits for the current top-level property,
 * output bytes for the whole model, and the levels it cut. Every charge is
 * made here, at the positions the Rust copies make it:
 * {@link ComplexPropertyBudget.admitMember} before reading a member,
 * {@link ComplexPropertyBudget.memberPart} once it is read,
 * {@link ComplexPropertyBudget.levelValue} once the level is done.
 */
export class ComplexPropertyBudget {
    private visits = 0;
    private bytesLeft: number;
    private cutLevels = 0;

    constructor(outputBytes: number = COMPLEX_PROPERTY_OUTPUT_BYTES) {
        this.bytesLeft = outputBytes;
    }

    /** The budget of one model whose source is `inputBytes` long. */
    static forInput(inputBytes: number): ComplexPropertyBudget {
        return new ComplexPropertyBudget(complexPropertyOutputBudget(inputBytes));
    }

    /** One listing of complex property `id` by a set: the first walks it
     *  (`resolve` starts the property and returns the value with its
     *  {@link complexPropertyListingBytes}), a later one reuses the value
     *  charged its listing bytes, or reads `spent()` (a counted cut) once the
     *  budget is spent. Memoised per id, not per listing. */
    listing<V>(memo: Map<number, [V, number]>, id: number, resolve: (budget: this) => [V, number], spent: () => V): V {
        const hit = memo.get(id);
        if (hit) {
            if (this.bytesLeft === 0) {
                this.cutLevels += 1;
                return spent();
            }
            this.charge(hit[1]);
            return hit[0];
        }
        const resolved = resolve(this);
        memo.set(id, resolved);
        return resolved[0];
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

    /** A read member under `name` ('' without one) with `display` ('' without a value): charge
     *  its entry, then return its charged `"Name: value"` part, or `null`
     *  when there is no display. */
    memberPart(name: string, display: string): string | null {
        this.charge(COMPLEX_PROPERTY_MEMBER_BYTES + utf8Length(name) + utf8Length(display));
        if (!display) return null;
        const part = name ? `${name}: ${display}` : display;
        this.charge(utf8Length(part));
        return part;
    }

    /** A level's value: its parts joined (then the marker when `cut`), the
     *  bare marker when cut with no parts, or `null` (the caller's usage name).
     *  Only a value with parts is charged. */
    levelValue(parts: string[], cut: boolean): string | null {
        if (cut) this.cutLevels += 1;
        if (parts.length === 0) return cut ? COMPLEX_PROPERTY_BUDGET_MARKER : null;
        const joined = parts.join(', ');
        const value = cut ? `${joined} ${COMPLEX_PROPERTY_BUDGET_MARKER}` : joined;
        this.charge(utf8Length(value));
        return value;
    }

    /** Levels and listings this budget has cut so far. */
    get cuts(): number {
        return this.cutLevels;
    }

    private charge(bytes: number): void {
        this.bytesLeft = Math.max(0, this.bytesLeft - bytes);
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
 * {@link COMPLEX_PROPERTY_BUDGET_MARKER}. Pass the model's: a property set's
 * listings are resolved once per store by `complexPropertyListingValue`
 * (`complex-property-store.ts`), and a caller outside a set passes one budget
 * for its whole pass. The default is a fresh budget for this one property.
 */
export function resolveComplexPropertyValue(
    store: IfcDataStore,
    extractor: EntityExtractor,
    propEntity: IfcEntity,
    budget: ComplexPropertyBudget = ComplexPropertyBudget.forInput(store.source?.length ?? 0)
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
    let cut = false;

    for (const ref of hasProperties) {
        if (typeof ref !== 'number') continue;
        if (!budget.admitMember()) {
            cut = true;
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
        // Every charge is the shared budget's, at the same point as the Rust walks.
        const part = budget.memberPart(nestedName, display);
        if (part === null) continue;
        parts.push(part);
        values.push(display);
    }

    const value = budget.levelValue(parts, cut) ?? (usageName || null);
    if (cut) {
        // A member past the cut reads as truncated, not absent (#7675 D3).
        values.push(COMPLEX_PROPERTY_BUDGET_MARKER);
        members.push({ name: COMPLEX_PROPERTY_BUDGET_MARKER, type: PropertyValueType.String, value: COMPLEX_PROPERTY_BUDGET_MARKER });
    }
    return {
        type: PropertyValueType.String,
        value,
        structure: 'complex',
        ...(values.length > 0 ? { values } : {}),
        ...(members.length > 0 ? { members } : {}),
    };
}
