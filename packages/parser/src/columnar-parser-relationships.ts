/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relationship extraction for columnar parsing.
 *
 * Byte-level relationship scanners that extract numeric entity IDs
 * from STEP relationship entities without TextDecoder overhead.
 */

import { skipCommas, readRefList } from './columnar-parser-attributes.js';
import { getRelationshipSlotPlan } from './relationship-schema-slots.js';

/**
 * Extract relatingObject and relatedObjects from a relationship entity using
 * byte-level scanning. No TextDecoder needed — only extracts numeric entity
 * IDs.
 *
 * The attribute positions come from {@link getRelationshipSlotPlan}
 * (schema-derived, per #4205) rather than a hand-written branch per STEP
 * keyword. `readRefList` accepts both a bare `#id` and a `(...)` list, so a
 * single read path serves the "relating" slot (always one reference) and the
 * "related" slot (one reference or a list) alike — the plan's `isList` flag
 * only documents which shape a class uses, it does not gate how the value is
 * read.
 */
export function extractRelFast(
    buffer: Uint8Array,
    byteOffset: number,
    byteLength: number,
    typeUpper: string,
): { relatingObject: number; relatedObjects: number[] } | null {
    const plan = getRelationshipSlotPlan(typeUpper);
    if (!plan) return null;

    const end = byteOffset + byteLength;
    let pos = byteOffset;

    while (pos < end && buffer[pos] !== 0x28) pos++;
    if (pos >= end) return null;
    pos++;

    // Skip to post-root attr[0] (all IfcRelationship subtypes share 4
    // IfcRoot+IfcRelationship attrs: GlobalId, OwnerHistory, Name, Description).
    pos = skipCommas(buffer, pos, end, 4);

    const slots = [
        { kind: 'relating' as const, ...plan.relating },
        { kind: 'related' as const, ...plan.related },
    ].sort((a, b) => a.index - b.index);

    let relatingIds: number[] = [];
    let relatedIds: number[] = [];
    let cursor = 0;
    for (const slot of slots) {
        pos = skipCommas(buffer, pos, end, slot.index - cursor);
        cursor = slot.index;
        const [ids, rp] = readRefList(buffer, pos, end);
        if (slot.kind === 'relating') relatingIds = ids;
        else relatedIds = ids;
        pos = rp;
        // `readRefList` returns `rp` pointing AT the closing `)` when it read
        // a parenthesised list — `skipCommas` tracks paren depth from its
        // start position, so leaving `pos` there makes that `)` register as
        // an unmatched close and miscount every comma after it. Advance past
        // it before the next slot's `skipCommas` call. A bare single `#id`
        // never leaves `rp` sitting on a `)`, so this is a no-op for it.
        if (pos < end && buffer[pos] === 0x29) pos++;
    }

    const relatingObject = relatingIds[0] ?? -1;
    if (relatingObject < 0 || relatedIds.length === 0) return null;
    return { relatingObject, relatedObjects: relatedIds };
}

/**
 * Extract property rel data: attr[4]=relatedObjects, attr[5]=relatingDef(s).
 * Numbers only, no TextDecoder.
 *
 * attr[5] is read as a ref LIST, not a single ref: it is reused for both
 * `IfcRelDefinesByProperties.RelatingPropertyDefinition` (typed
 * `IfcPropertySetDefinitionSelect`, whose second alternative
 * `IfcPropertySetDefinitionSet` is a `SET [1:?] OF IfcPropertySetDefinition`
 * and is written as a parenthesised list, e.g. `(#20,#21)`, not `#20`) and
 * the single-ref `IfcRelAssociates*` selects (`IfcMaterialSelect` /
 * `IfcClassificationSelect` / `IfcDocumentSelect`, always one ref).
 * `readRefList` already accepts both a bare `#id` and a `(...)` list, so one
 * call handles both callers; the single-ref case is a length-1 list. A prior
 * version used `readRefId` here, which only recognises a bare `#id` — for a
 * schema-legal grouped `IfcPropertySetDefinitionSet` (`(#20,#21)`) it saw the
 * list's opening `(` instead of `#`, returned -1, and this function returned
 * null, silently dropping the WHOLE `IfcRelDefinesByProperties` relationship:
 * every related object lost all properties/quantities from that pset group.
 */
export function extractPropertyRelFast(
    buffer: Uint8Array,
    byteOffset: number,
    byteLength: number,
): { relatedObjects: number[]; relatingDefs: number[] } | null {
    const end = byteOffset + byteLength;
    let pos = byteOffset;

    while (pos < end && buffer[pos] !== 0x28) pos++;
    if (pos >= end) return null;
    pos++;

    pos = skipCommas(buffer, pos, end, 4);

    const [relatedObjects, rp] = readRefList(buffer, pos, end);
    pos = rp;
    while (pos < end && buffer[pos] !== 0x2C) pos++;
    pos++;

    const [relatingDefs, _] = readRefList(buffer, pos, end);
    if (relatingDefs.length === 0 || relatedObjects.length === 0) return null;
    return { relatedObjects, relatingDefs };
}
