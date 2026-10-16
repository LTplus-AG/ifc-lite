/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one TypeScript reader of `IfcRelDefinesByProperties.RelatingPropertyDefinition`
 * (attribute 5), the byte-level twin of Rust's `AttributeValue::as_ref_members`
 * plus `DecodedEntity::get_refs` (`rust/core/src/schema_gen.rs`, #7681).
 *
 * The attribute is `IfcPropertySetDefinitionSelect`, a SELECT of an entity and
 * of the defined type `IfcPropertySetDefinitionSet` (a `SET OF` entity). It
 * therefore appears in three spellings, all read here:
 *
 *   `#20`                                      a single reference
 *   `(#20,#22)`                                a bare set, as most exporters write it
 *   `IFCPROPERTYSETDEFINITIONSET((#20,#22))`   the typed form ISO 10303-21 requires
 *                                              for a defined type inside a SELECT
 *
 * The shared vectors in `rust/core/tests/fixtures/property_definition_refs_vectors.json`
 * pin this reader and the Rust one to the same answers
 * (`property-definition-refs.parity.test.ts`).
 *
 * Semantics, identical to Rust:
 *  - A typed value `NAME(a, b)` is the list `[NAME, a, b]`. It is unwrapped to
 *    its set only when NAME is exactly `IFCPROPERTYSETDEFINITIONSET`
 *    (case-insensitive) and it has ONE argument that is itself a list. Every
 *    other shape keeps its direct arguments as the members.
 *  - Members that are not entity references are skipped; nothing is read out
 *    of a nested list, a typed value or a string literal.
 *  - No references at all, or a record that does not tokenize (unbalanced
 *    parentheses, an unterminated string or comment, nesting past 256, a value
 *    not followed by `,` or `)`), reads as no references, which drops the
 *    relationship as Rust does. Only this attribute is checked, not the rest
 *    of the record.
 */

import { readRefId } from './columnar-parser-attributes.js';
import { isSpaceByte, opensComment, skipComment, skipStringLiteral } from './step-lexing.js';

/** Same bound as `MAX_NESTING_DEPTH` in rust/core/src/parser/tokenizer.rs. */
const MAX_NESTING_DEPTH = 256;

const KEYWORD = 'IFCPROPERTYSETDEFINITIONSET';
const OTHER = -1;

interface Typed { definitionSet: boolean; args: Value[] }
/** An entity id (>= 0), `OTHER`, a list, or a typed value. */
type Value = number | Value[] | Typed;

function isKeywordByte(b: number): boolean {
    return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f;
}

/** Skip whitespace and `/* ... *\/` comments; -1 for a comment that never closes. */
function skipTrivia(buffer: Uint8Array, pos: number, end: number): number {
    for (;;) {
        while (pos < end && isSpaceByte(buffer[pos])) pos++;
        if (pos >= end || !opensComment(buffer, pos, end)) return pos;
        pos = skipComment(buffer, pos, end);
        if (pos < 0) return -1;
    }
}

function isDefinitionSetName(buffer: Uint8Array, start: number, stop: number): boolean {
    if (stop - start !== KEYWORD.length) return false;
    for (let i = 0; i < KEYWORD.length; i++) {
        const b = buffer[start + i];
        if ((b >= 0x61 && b <= 0x7a ? b - 0x20 : b) !== KEYWORD.charCodeAt(i)) return false;
    }
    return true;
}

/** Items of `( ... )` starting AFTER the `(`. Returns the next position, or -1. */
function readItems(buffer: Uint8Array, pos: number, end: number, depth: number, into: Value[]): number {
    pos = skipTrivia(buffer, pos, end);
    if (pos < 0 || pos >= end) return -1;
    if (buffer[pos] === 0x29) return pos + 1;
    for (;;) {
        const next = readValue(buffer, pos, end, depth, into);
        if (next < 0) return -1;
        pos = skipTrivia(buffer, next, end);
        if (pos < 0 || pos >= end) return -1;
        if (buffer[pos] === 0x29) return pos + 1;
        if (buffer[pos] !== 0x2c) return -1;
        pos = skipTrivia(buffer, pos + 1, end);
        if (pos < 0) return -1;
    }
}

/** Read one value at `pos`, pushing it onto `into`. Returns the next position, or -1. */
function readValue(buffer: Uint8Array, pos: number, end: number, depth: number, into: Value[]): number {
    if (depth > MAX_NESTING_DEPTH) return -1;
    pos = skipTrivia(buffer, pos, end);
    if (pos < 0 || pos >= end) return -1;
    const b = buffer[pos];
    if (b === 0x23) {
        const [id, next] = readRefId(buffer, pos, end);
        if (next === pos) return -1;
        into.push(id >= 0 ? id : OTHER);
        return next;
    }
    if (b === 0x28) {
        const items: Value[] = [];
        const next = readItems(buffer, pos + 1, end, depth + 1, items);
        if (next < 0) return -1;
        into.push(items);
        return next;
    }
    if (b === 0x27 || b === 0x22) {
        let next: number;
        if (b === 0x27) next = skipStringLiteral(buffer, pos, end);
        else {
            next = pos + 1;
            while (next < end && buffer[next] !== 0x22) next++;
            next = next < end ? next + 1 : -1;
        }
        if (next < 0) return -1;
        into.push(OTHER);
        return next;
    }
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) {
        let nameEnd = pos;
        while (nameEnd < end && isKeywordByte(buffer[nameEnd])) nameEnd++;
        const open = skipTrivia(buffer, nameEnd, end);
        if (open < 0 || open >= end || buffer[open] !== 0x28) return -1;
        const args: Value[] = [];
        const next = readItems(buffer, open + 1, end, depth + 1, args);
        if (next < 0) return -1;
        into.push({ definitionSet: isDefinitionSetName(buffer, pos, nameEnd), args });
        return next;
    }
    // `$`, `*`, `.ENUM.`, a number: one opaque member.
    let next = pos + 1;
    while (next < end) {
        const c = buffer[next];
        if (c === 0x2c || c === 0x29 || c === 0x28 || c === 0x27 || isSpaceByte(c) || opensComment(buffer, next, end)) break;
        next++;
    }
    into.push(OTHER);
    return next;
}

/** The items a list-like value holds; a typed value's name is not a reference. */
function itemsOf(value: Value): Value[] | null {
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') return value.args;
    return null;
}

/**
 * Entity ids named by the attribute value starting at `pos`, in written order
 * (a repeated id stays repeated, like Rust's `get_refs`; the store boundary
 * decides whether to collapse it). Empty when the value holds none.
 */
export function readPropertyDefinitionRefs(buffer: Uint8Array, pos: number, end: number): number[] {
    const parsed: Value[] = [];
    const next = readValue(buffer, pos, end, 0, parsed);
    if (next < 0) return [];
    // The value must be followed by the next attribute or the record's own `)`.
    // A set missing its `)` otherwise swallows the record's, and a record Rust
    // refuses to decode would still yield references here.
    const after = skipTrivia(buffer, next, end);
    if (after < 0 || after >= end || (buffer[after] !== 0x2c && buffer[after] !== 0x29)) return [];
    const value = parsed[0];

    let members: Value[];
    if (typeof value === 'number') {
        return value >= 0 ? [value] : [];
    } else if (Array.isArray(value)) {
        members = value;
    } else {
        const only = value.args.length === 1 ? itemsOf(value.args[0]) : null;
        members = value.definitionSet && only ? only : value.args;
    }
    const ids: number[] = [];
    for (const member of members) {
        if (typeof member === 'number' && member >= 0) ids.push(member);
    }
    return ids;
}

function numericRef(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The same read over an already DECODED attribute value, for the readers that
 * hold `entity.attributes[5]` rather than record bytes. A decoded typed value
 * is `[NAME, ...args]` (`EntityExtractor` mirrors the Rust tokenizer), so the
 * rule is the byte reader's: unwrap `[IFCPROPERTYSETDEFINITIONSET, [set]]`,
 * otherwise keep the direct members; skip anything that is not a reference.
 *
 * `readRef` says what a reference looks like in the caller's values: the
 * default accepts the parsed numeric ids; a caller whose records also carry
 * authored `'#123'` tokens passes its own reader. Written order, repeats kept.
 *
 * Known divergence: a decoded reference is a bare number, so the default
 * `readRef` cannot tell `#1500` from a stray `1500` (`(#20,1.5E3,#22)` reads
 * as `[20,1500,22]`; the byte reader and Rust give `[20,22]`). A caller whose
 * values may hold such scalars passes a `readRef` that also checks the number
 * names an entity, as `current-type-quantities.ts` does.
 */
export function propertyDefinitionRefsOfValue(
    value: unknown,
    readRef: (member: unknown) => number | null = numericRef,
): number[] {
    const single = readRef(value);
    if (single !== null) return [single];
    if (!Array.isArray(value)) return [];
    const wrapped = value.length === 2
        && typeof value[0] === 'string'
        && value[0].toUpperCase() === KEYWORD
        && Array.isArray(value[1]);
    const members: unknown[] = wrapped ? value[1] : value;
    const ids: number[] = [];
    for (const member of members) {
        const id = readRef(member);
        if (id !== null) ids.push(id);
    }
    return ids;
}
