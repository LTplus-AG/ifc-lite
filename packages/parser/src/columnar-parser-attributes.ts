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

    // Skip commas to reach the target attribute
    if (attrIndex > 0) {
        let toSkip = attrIndex;
        let depth = 0;
        let inStr = false;
        while (pos < end && toSkip > 0) {
            const ch = buffer[pos];
            if (ch === 0x27 /* ' */) {
                if (inStr && pos + 1 < end && buffer[pos + 1] === 0x27) {
                    pos += 2; continue;
                }
                inStr = !inStr;
            } else if (!inStr) {
                if (ch === 0x28) depth++;
                else if (ch === 0x29) depth--;
                else if (ch === 0x2C && depth === 0) toSkip--;
            }
            pos++;
        }
    }

    // Skip whitespace
    while (pos < end && (buffer[pos] === 0x20 || buffer[pos] === 0x09)) pos++;

    // Check for quoted string
    if (pos >= end || buffer[pos] !== 0x27 /* ' */) return null;
    pos++; // skip opening quote
    const start = pos;

    // Find closing quote (handle escaped quotes '')
    while (pos < end) {
        if (buffer[pos] === 0x27) {
            if (pos + 1 < end && buffer[pos + 1] === 0x27) {
                pos += 2; continue;
            }
            break;
        }
        pos++;
    }
    return [start, pos];
}

/**
 * Skip N commas at depth 0 in STEP bytes.
 */
export function skipCommas(buffer: Uint8Array, start: number, end: number, count: number): number {
    let pos = start;
    let remaining = count;
    let depth = 0;
    let inString = false;
    while (pos < end && remaining > 0) {
        const ch = buffer[pos];
        if (ch === 0x27) {
            if (inString && pos + 1 < end && buffer[pos + 1] === 0x27) { pos += 2; continue; }
            inString = !inString;
        } else if (!inString) {
            if (ch === 0x28) depth++;
            else if (ch === 0x29) depth--;
            else if (ch === 0x2C && depth === 0) remaining--;
        }
        pos++;
    }
    return pos;
}

/** Read a #ID entity reference as a number. Returns -1 if not an entity ref. */
export function readRefId(buffer: Uint8Array, pos: number, end: number): [number, number] {
    while (pos < end && (buffer[pos] === 0x20 || buffer[pos] === 0x09)) pos++;
    if (pos < end && buffer[pos] === 0x23) {
        pos++;
        let num = 0;
        while (pos < end && buffer[pos] >= 0x30 && buffer[pos] <= 0x39) {
            num = num * 10 + (buffer[pos] - 0x30);
            pos++;
        }
        return [num, pos];
    }
    return [-1, pos];
}

/** Read a list of entity refs (#id1,#id2,...) or a single #id. Returns [ids, newPos]. */
export function readRefList(buffer: Uint8Array, pos: number, end: number): [number[], number] {
    while (pos < end && (buffer[pos] === 0x20 || buffer[pos] === 0x09)) pos++;
    const ids: number[] = [];

    if (pos < end && buffer[pos] === 0x28) {
        pos++;
        while (pos < end && buffer[pos] !== 0x29) {
            while (pos < end && (buffer[pos] === 0x20 || buffer[pos] === 0x09 || buffer[pos] === 0x2C)) pos++;
            if (pos < end && buffer[pos] === 0x23) {
                const [id, np] = readRefId(buffer, pos, end);
                if (id >= 0) ids.push(id);
                pos = np;
            } else if (pos < end && buffer[pos] !== 0x29) {
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
 * Batch extract GlobalId (attr[0]) and Name (attr[2]) for many entities using
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
): Promise<Map<number, { globalId: string; name: string }>> {
    const result = new Map<number, { globalId: string; name: string }>();
    if (refs.length === 0) return result;
    const CHUNK_SIZE = 2048;

    // Phase 1: Scan byte ranges for GlobalId and Name positions (no string allocation)
    const gidRanges: Array<[number, number]> = []; // [start, end) for each entity
    const nameRanges: Array<[number, number]> = [];
    const validIndices: number[] = []; // indices into refs for entities with valid ranges

    for (let i = 0; i < refs.length; i++) {
        if (yieldIfNeeded && (i & (CHUNK_SIZE - 1)) === 0) {
            await yieldIfNeeded();
        }
        const ref = refs[i];
        const gidRange = findQuotedAttrRange(buffer, ref.byteOffset, ref.byteLength, 0);
        const nameRange = findQuotedAttrRange(buffer, ref.byteOffset, ref.byteLength, 2);

        gidRanges.push(gidRange ?? [0, 0]);
        nameRanges.push(nameRange ?? [0, 0]);
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
        result.set(ref.expressId, {
            globalId: gids[i] || '',
            name: rawName ? decodeIfcString(rawName) : '',
        });
    }

    return result;
}
