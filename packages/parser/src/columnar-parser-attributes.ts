/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Low-level buffer attribute utilities for columnar parsing.
 *
 * Pure functions that operate on raw Uint8Array buffers to extract
 * STEP entity attributes without TextDecoder overhead.
 */

import type { EntityRef } from './types.js';
import { decodeIfcString } from '@ifc-lite/encoding';
import { isIndexableExpressId } from './express-id.js';
import { opensComment, skipComment, skipStringLiteral, skipTrivia } from './step-lexing.js';
import { EntityExtractor } from './entity-extractor.js';
import { getRootAttrIndices } from './columnar-parser-root-attributes.js';

/** Does `ref`'s byte range contain a `/*` comment opener? Cheap linear scan,
 *  only run on a record `findQuotedAttrRange` already failed to read. */
function hasCommentOpener(buffer: Uint8Array, ref: EntityRef): boolean {
    const end = ref.byteOffset + ref.byteLength - 1;
    for (let p = ref.byteOffset; p < end; p++) {
        if (buffer[p] === 0x2f && buffer[p + 1] === 0x2a) return true;
    }
    return false;
}

/**
 * Find the byte range of a quoted string at a specific attribute position in STEP entity bytes.
 * Returns [start, end) byte offsets (excluding quotes), or null if not found.
 *
 * @param buffer - The IFC file buffer
 * @param entityStart - byte offset of the entity
 * @param entityLen - byte length of the entity
 * @param attrIndex - 0-based attribute index (0=GlobalId, 2=Name)
 */
export function findQuotedAttrRange(
    buffer: Uint8Array,
    entityStart: number,
    entityLen: number,
    attrIndex: number,
): [number, number] | null {
    const end = entityStart + entityLen;
    let pos = entityStart;

    // Skip to opening paren '(' after TYPE name
    while (pos < end && buffer[pos] !== 0x28 /* ( */) pos++;
    if (pos >= end) return null;
    pos++; // skip '('

    // Skip commas to reach the target attribute. A string literal is skipped
    // whole by step-lexing's `skipStringLiteral`, the one rule for where a
    // literal ends: `''` and a `\S\` PAGE operand are text, so the comma in
    // `'Para \S\' 5'` is not a separator (#7589).
    if (attrIndex > 0) {
        let toSkip = attrIndex;
        let depth = 0;
        while (pos < end && toSkip > 0) {
            const ch = buffer[pos];
            if (ch === 0x27 /* ' */) {
                const next = skipStringLiteral(buffer, pos, end);
                if (next < 0) return null;
                pos = next;
                continue;
            }
            if (ch === 0x28) depth++;
            else if (ch === 0x29) depth--;
            else if (ch === 0x2C && depth === 0) toSkip--;
            pos++;
        }
    }

    // Skip whitespace — including \n/\r: STEP records may wrap attributes
    // across source lines, so a quoted attr can start on a new line
    // (schependomlaan storey/covering-type names). Form feed (0x0C) and
    // vertical tab (0x0B) are included too, kept in sync with isSpaceByte
    // in step-lexing.ts (#3733): without them, a GlobalId/Name preceded by
    // either byte silently fails to match here and this function returns
    // null, the same drop shape the entity scanners had.
    while (pos < end && (buffer[pos] === 0x20 || buffer[pos] === 0x09 || buffer[pos] === 0x0A || buffer[pos] === 0x0D || buffer[pos] === 0x0C || buffer[pos] === 0x0B)) pos++;

    // Check for quoted string
    if (pos >= end || buffer[pos] !== 0x27 /* ' */) return null;
    // The literal ends where `skipStringLiteral` says (#7589); an
    // unterminated one runs to the record's end, as it always has.
    const close = skipStringLiteral(buffer, pos, end);
    return [pos + 1, close < 0 ? end : close - 1];
}

/**
 * True unless the attribute at `attrIndex` is the IFC "not present" token
 * `$`. False (not true) when the record's attribute list is too short to
 * reach `attrIndex` at all, matching how `entity.get(N).is_some_and(|a|
 * !a.is_null())` reads a missing attribute on the Rust export side
 * (`rust/processing/src/data_model/rows/mod.rs`) — an absent slot means "no value", not
 * "assume present".
 *
 * Used for `Representation` (index 6) on `IfcProduct` descendants: GlobalId,
 * OwnerHistory, Name, Description, ObjectType, ObjectPlacement,
 * Representation — `IfcProduct` is the last ancestor in the chain to declare
 * an attribute before this one, so every subtype (`IfcElement`, `IfcWall`,
 * `IfcBuildingElementProxy`, `IfcSpatialElement`, …) inherits `Representation`
 * at this exact position; subtypes only append attributes after it. Callers
 * are responsible for only calling this on an `IfcProduct` descendant.
 *
 * ISO 10303-21 allows a `/* ... *\/` comment anywhere whitespace is legal,
 * including between attributes and right before the target value — a
 * comma inside an earlier comment must not count as a delimiter either, or
 * the scan lands on the wrong slot entirely. Both `skipCommas` (below) and
 * the final approach to `attrIndex` use `step-lexing.ts`'s comment-aware
 * `skipTrivia`/`opensComment`/`skipComment` — the same helpers the
 * tokenizer uses — rather than a second, partial comment lexer: a raw
 * six-byte whitespace test here previously read `,/* omitted *\/$,` as
 * landing ON the `/` and reported the attribute present (#4725 review).
 */
export function hasAttrValueAt(
    buffer: Uint8Array,
    entityStart: number,
    entityLen: number,
    attrIndex: number,
): boolean {
    const end = entityStart + entityLen;
    let pos = entityStart;
    while (pos < end && buffer[pos] !== 0x28 /* ( */) pos++;
    if (pos >= end) return false;
    pos++; // skip '('
    pos = skipCommas(buffer, pos, end, attrIndex);
    const trivia = skipTrivia(buffer, pos, end);
    pos = trivia.next;
    if (trivia.stop || pos >= end) return false;
    return buffer[pos] !== 0x24 /* $ */;
}

/**
 * Skip N commas at depth 0 in STEP bytes.
 *
 * Comment-aware: a `/* ... *\/` comment is legal wherever whitespace is
 * legal in a record's attribute list, so a comma or quote INSIDE one must
 * not be read as a delimiter or a string opener. Comments are skipped
 * whole via `step-lexing.ts`'s `opensComment`/`skipComment` (the same
 * comment scanner the tokenizer uses) before the comma/paren/quote checks
 * run, so `(...,#165,/* a, b *\/$,...)` still lands the `$` at the slot
 * right after `#165`, not one early from the comma inside the comment.
 */
export function skipCommas(buffer: Uint8Array, start: number, end: number, count: number): number {
    let pos = start;
    let remaining = count;
    let depth = 0;
    while (pos < end && remaining > 0) {
        const ch = buffer[pos];
        // A literal is skipped whole by the shared rule, so a `\S\` PAGE
        // operand does not end it early (#7589); one that never closes runs
        // to `end`, as the toggle it replaced did.
        if (ch === 0x27) {
            const next = skipStringLiteral(buffer, pos, end);
            pos = next < 0 ? end : next;
            continue;
        }
        if (opensComment(buffer, pos, end)) {
            const next = skipComment(buffer, pos, end);
            pos = next < 0 ? end : next;
            continue;
        }
        if (ch === 0x28) depth++;
        else if (ch === 0x29) depth--;
        else if (ch === 0x2C && depth === 0) remaining--;
        pos++;
    }
    return pos;
}

/** Read a #ID entity reference as a number. Returns -1 if not an entity ref. */
export function readRefId(buffer: Uint8Array, pos: number, end: number): [number, number] {
    // Kept in sync with isSpaceByte in step-lexing.ts (#3733): form feed
    // (0x0C) and vertical tab (0x0B) are legal separators too, or a ref
    // preceded by either silently reads as "no reference here" (-1).
    while (pos < end && (buffer[pos] === 0x20 || buffer[pos] === 0x09 || buffer[pos] === 0x0A || buffer[pos] === 0x0D || buffer[pos] === 0x0C || buffer[pos] === 0x0B)) pos++;
    if (pos < end && buffer[pos] === 0x23) {
        pos++;
        let num = 0;
        while (pos < end && buffer[pos] >= 0x30 && buffer[pos] <= 0x39) {
            num = num * 10 + (buffer[pos] - 0x30);
            pos++;
        }
        // `num * 10 + digit` overflows to Infinity only past ~309 digits, but
        // it stops meaning anything long before that: doubles lose integer
        // precision past 2^53 (~16 digits), so `#100000000000000001` and
        // `#100000000000000002` accumulate to the SAME value, and the 32-bit
        // express-id columns below truncate anything above 2^32 so that
        // `#4294967297` lands on `#1`. `isIndexableExpressId` is the single
        // home for that bound (express-id.ts, #3395).
        // Guarding at each accumulator (here, and both `StepTokenizer` scans,
        // and the inline scan worker) rather than only when the entity is
        // extracted: this is the byte-level path that builds the
        // property/relationship indexes, so an unguarded overflow here keyed a
        // pset under a record the entity index had already refused —
        // `extractPropertiesOnDemand(store, Infinity)` returned a real pset for
        // an entity whose own GlobalId and Name were unreadable.
        //
        // `-1` is this function's existing "no reference here" sentinel and
        // every caller already tests it (`if (relating < 0) return null`,
        // `if (id >= 0) ids.push(id)`). `pos` is still returned advanced past
        // the digits so scanning continues from the right place.
        if (!isIndexableExpressId(num)) return [-1, pos];
        return [num, pos];
    }
    return [-1, pos];
}

/** Read a list of entity refs (#id1,#id2,...) or a single #id. Returns [ids, newPos]. */
export function readRefList(buffer: Uint8Array, pos: number, end: number): [number[], number] {
    // Trivia is whitespace AND `/* ... */` comments (#7785): a `#` or `)` inside
    // a comment is not structure. A comment that never closes runs to `end`.
    pos = skipTrivia(buffer, pos, end).next;
    const ids: number[] = [];

    if (pos < end && buffer[pos] === 0x28) {
        pos++;
        while (pos < end && buffer[pos] !== 0x29) {
            const gap = skipTrivia(buffer, pos, end);
            pos = gap.next;
            if (gap.stop) break;
            if (pos >= end || buffer[pos] === 0x29) break;
            const b = buffer[pos];
            if (b === 0x2C) {
                pos++;
            } else if (b === 0x23) {
                const [id, np] = readRefId(buffer, pos, end);
                if (id >= 0) ids.push(id);
                pos = np;
            } else if (b === 0x27) {
                const next = skipStringLiteral(buffer, pos, end);
                pos = next < 0 ? end : next;
            } else {
                pos++;
            }
        }
    } else if (pos < end && buffer[pos] === 0x23) {
        const [id, np] = readRefId(buffer, pos, end);
        if (id >= 0) ids.push(id);
        pos = np;
    }
    return [ids, pos];
}

/**
 * Batch extract schema-declared GlobalId and Name for many entities using
 * only 2 TextDecoder.decode() calls total (one for all GlobalIds, one for all Names).
 *
 * This is ~100x faster than calling extractEntity() per entity for large batches
 * because it eliminates per-entity TextDecoder overhead which is significant in Firefox.
 *
 * Returns a Map from expressId → { globalId, name }.
 */
export async function batchExtractGlobalIdAndName(
    buffer: Uint8Array,
    refs: EntityRef[],
    yieldIfNeeded?: () => Promise<void>,
): Promise<Map<number, { globalId: string; name: string | undefined }>> {
    const result = new Map<number, { globalId: string; name: string | undefined }>();
    if (refs.length === 0) return result;
    const CHUNK_SIZE = 2048;

    // Phase 1: Scan byte ranges for GlobalId and Name positions (no string allocation)
    const gidRanges: Array<[number, number]> = []; // [start, end) for each entity
    const nameRanges: Array<[number, number]> = [];
    // `null` ($) vs `[start, start]` ('') both concatenate to zero bytes
    // below, so capture the distinction here before it's lost (#4930).
    const nameFound: boolean[] = [];
    // `findQuotedAttrRange` has no `/* … */` trivia skip (pre-existing, both
    // attrs), so a comment before GlobalId/Name is a false miss here — flag
    // it for the slow-path re-parse below rather than trusting `null`.
    const commentSuspect: boolean[] = [];
    const validIndices: number[] = []; // indices into refs for entities with valid ranges

    for (let i = 0; i < refs.length; i++) {
        if (yieldIfNeeded && (i & (CHUNK_SIZE - 1)) === 0) {
            await yieldIfNeeded();
        }
        const ref = refs[i];
        const schema = getRootAttrIndices(ref.type);
        // Known roots keep the same 0/2 fast path. Known non-roots must not
        // project Name as GlobalId; unknown vendor types retain the existing
        // explicit IfcRoot-position policy used by on-demand extraction.
        const gidIndex = schema.known ? schema.globalId : 0;
        const nameIndex = schema.known ? schema.name : 2;
        const gidRange = gidIndex < 0 ? null : findQuotedAttrRange(buffer, ref.byteOffset, ref.byteLength, gidIndex);
        const nameRange = nameIndex < 0 ? null : findQuotedAttrRange(buffer, ref.byteOffset, ref.byteLength, nameIndex);

        gidRanges.push(gidRange ?? [0, 0]);
        nameRanges.push(nameRange ?? [0, 0]);
        nameFound.push(nameRange !== null);
        commentSuspect.push(((gidIndex >= 0 && gidRange === null) || (nameIndex >= 0 && nameRange === null)) && hasCommentOpener(buffer, ref));
        validIndices.push(i);
    }

    // Phase 2: Concatenate all GlobalId bytes into one buffer, decode once
    // Use null byte (0x00) as separator (never appears in IFC string content)
    let totalGidBytes = 0;
    let totalNameBytes = 0;
    for (let i = 0; i < validIndices.length; i++) {
        if (yieldIfNeeded && (i & (CHUNK_SIZE - 1)) === 0) {
            await yieldIfNeeded();
        }
        const [gs, ge] = gidRanges[i];
        const [ns, ne] = nameRanges[i];
        totalGidBytes += (ge - gs) + 1; // +1 for separator
        totalNameBytes += (ne - ns) + 1;
    }

    const gidBuf = new Uint8Array(totalGidBytes);
    const nameBuf = new Uint8Array(totalNameBytes);
    let gidOffset = 0;
    let nameOffset = 0;

    for (let i = 0; i < validIndices.length; i++) {
        if (yieldIfNeeded && (i & (CHUNK_SIZE - 1)) === 0) {
            await yieldIfNeeded();
        }
        const [gs, ge] = gidRanges[i];
        const [ns, ne] = nameRanges[i];

        if (ge > gs) {
            gidBuf.set(buffer.subarray(gs, ge), gidOffset);
            gidOffset += ge - gs;
        }
        gidBuf[gidOffset++] = 0; // null separator

        if (ne > ns) {
            nameBuf.set(buffer.subarray(ns, ne), nameOffset);
            nameOffset += ne - ns;
        }
        nameBuf[nameOffset++] = 0;
    }

    // Phase 3: Two TextDecoder calls for ALL entities
    const decoder = new TextDecoder();
    const allGids = decoder.decode(gidBuf.subarray(0, gidOffset));
    const allNames = decoder.decode(nameBuf.subarray(0, nameOffset));
    const gids = allGids.split('\0');
    const names = allNames.split('\0');

    // Phase 4: Build result map
    for (let i = 0; i < validIndices.length; i++) {
        if (yieldIfNeeded && (i & (CHUNK_SIZE - 1)) === 0) {
            await yieldIfNeeded();
        }
        const ref = refs[validIndices[i]];
        const rawName = names[i] || '';
        // Collapse STEP doubled single-quotes ('' -> ') BEFORE decoding, exactly
        // as EntityExtractor does. The raw byte slice preserves the doubling, and
        // decodeIfcString deliberately never touches quotes, so without this a
        // name like `John''s Wall` would render with the literal doubled quote.
        result.set(ref.expressId, {
            globalId: gids[i] || '',
            name: nameFound[i]
                ? (rawName ? decodeIfcString(rawName.replace(/''/g, "'")) : '')
                : undefined,
        });
    }

    // Phase 5: re-parse the (rare) comment-blind misses with the real
    // tokenizer instead of trusting the fast path's false "absent".
    let fallback: EntityExtractor | undefined;
    for (let i = 0; i < validIndices.length; i++) {
        if (!commentSuspect[i]) continue;
        const ref = refs[validIndices[i]];
        const attrs = (fallback ??= new EntityExtractor(buffer)).extractEntity(ref)?.attributes ?? [];
        const schema = getRootAttrIndices(ref.type);
        const globalId = attrs[schema.known ? schema.globalId : 0];
        const name = attrs[schema.known ? schema.name : 2];
        result.set(ref.expressId, {
            globalId: typeof globalId === 'string' ? globalId : '',
            name: typeof name === 'string' ? name : undefined,
        });
    }

    return result;
}
