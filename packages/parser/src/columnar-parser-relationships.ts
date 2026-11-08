/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relationship extraction for columnar parsing.
 *
 * Byte-level relationship scanners that extract numeric entity IDs
 * from STEP relationship entities without TextDecoder overhead.
 */

import { skipCommas, readRefId, readRefList } from './columnar-parser-attributes.js';
import { readPropertyDefinitionValue } from './property-definition-refs.js';
import { getRelationshipReadPlan } from './relationship-schema-slots.js';
import { skipGap } from './step-lexing.js';
import type { IfcDataStore } from './columnar-parser.js';

/**
 * True when the slot value that ended at `next` is followed by what the class
 * declares there: the next attribute's `,`, or the record's own closing `)`.
 * The last declared attribute admits only the closing `)`.
 *
 * This is where a misread record shows (#9192). A related list that stopped
 * at a nested or typed value has `next` -1, as does one whose members are not
 * `#id` or `$` one comma apart: `(#10 #11)` decodes as `[#10]` while the byte
 * reader took both, and a string or number member (`'#12'`, `12`) decodes as
 * a reference the byte reader skipped. A value followed by a stray `)`,
 * as in `(#10),#14),#40`, is not at the record's end. And a related value
 * missing its parentheses, `#10,#11,#40`, leaves the relating slot followed
 * by another value. In each case the graph would not list exactly the
 * references the record holds, so the caller records no edge for the record,
 * and its readers treat it as unreadable.
 */
function endsSlot(buffer: Uint8Array, next: number, end: number, last: boolean): boolean {
    if (next < 0) return false;
    let pos = skipGap(buffer, next, end);
    if (pos < 0 || pos >= end) return false;
    if (buffer[pos] === 0x2C) return !last;
    if (buffer[pos] !== 0x29) return false;
    pos = skipGap(buffer, pos + 1, end);
    // The record's range may or may not include its `;`.
    return pos >= end || buffer[pos] === 0x3B;
}

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
    schemaVersion?: IfcDataStore['schemaVersion'],
): { relatingObject: number; relatedObjects: number[] } | null {
    const plan = getRelationshipReadPlan(typeUpper, schemaVersion);
    if (!plan) return null;

    const end = byteOffset + byteLength;
    let pos = byteOffset;

    while (pos < end && buffer[pos] !== 0x28) pos++;
    if (pos >= end) return null;
    pos++;

    // Skip to post-root attr[0] (all IfcRelationship subtypes share 4
    // IfcRoot+IfcRelationship attrs: GlobalId, OwnerHistory, Name, Description).
    pos = skipCommas(buffer, pos, end, 4);

    let relatingObject = -1;
    let relatedIds: number[] = [];
    let cursor = 0;
    for (const slot of plan.order) {
        pos = skipCommas(buffer, pos, end, slot.index - cursor);
        cursor = slot.index;
        const [ids, , next] = readRefList(buffer, pos, end);
        if (!endsSlot(buffer, next, end, slot.index === plan.lastIndex)) return null;
        if (slot.relating) {
            // A relating attribute names one entity. `(#40,#41)` would give
            // an edge from #40 alone and hide that the record names #41.
            if (ids.length !== 1) return null;
            relatingObject = ids[0];
        } else {
            relatedIds = ids;
        }
        // `next` is past a list's closing `)`: `skipCommas` tracks paren depth
        // from its start position, so starting AT that `)` would count it as
        // an unmatched close and miscount every comma after it.
        pos = next;
    }

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
 *
 * As in {@link extractRelFast}, a record gets no edges unless its relating
 * value holds only references (and empty `$` members): `((#24),#41)`,
 * `(#24,'x')` and `IFCPROPERTYSETDEFINITIONSET((#24),#41)` are skipped, not
 * read as `[#41]` or `[#24]` (#9192). `singleRelating` is for the
 * `IfcRelAssociates*` classes, whose relating attribute names one entity:
 * `(#40,#41)` is skipped there rather than read as #40 alone.
 */
export function extractPropertyRelFast(
    buffer: Uint8Array,
    byteOffset: number,
    byteLength: number,
    singleRelating = false,
): { relatedObjects: number[]; relatingDefs: number[] } | null {
    const end = byteOffset + byteLength;
    let pos = byteOffset;

    while (pos < end && buffer[pos] !== 0x28) pos++;
    if (pos >= end) return null;
    pos++;

    pos = skipCommas(buffer, pos, end, 4);

    // RelatedObjects, then the relating attribute, which every class read
    // here declares last (#9192: see endsSlot).
    const [relatedObjects, , next] = readRefList(buffer, pos, end);
    pos = next < 0 ? -1 : skipGap(buffer, next, end);
    if (pos < 0 || buffer[pos] !== 0x2C) return null;
    pos++;

    let relatingDefs: number[];
    pos = skipGap(buffer, pos, end);
    if (pos >= 0 && buffer[pos] === 0x23) {
        // One reference, as nearly every record writes it: what the general
        // reader below gives for it, without tokenizing a value tree.
        const [id, after] = readRefId(buffer, pos, end);
        if (!endsSlot(buffer, after, end, true)) return null;
        relatingDefs = id >= 0 ? [id] : [];
    } else {
        const relating = pos < 0 ? null : readPropertyDefinitionValue(buffer, pos, end);
        if (!relating || !relating.plain || !endsSlot(buffer, relating.next, end, true)) return null;
        // A SET holds each member once; `(#20,#20)` must not add the edge twice.
        const written = relating.ids;
        if (singleRelating && written.length !== 1) return null;
        relatingDefs = written.length > 1 ? [...new Set(written)] : written;
    }
    if (relatingDefs.length === 0 || relatedObjects.length === 0) return null;
    return { relatedObjects, relatingDefs };
}
