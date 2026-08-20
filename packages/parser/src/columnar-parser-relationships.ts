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

/**
 * Extract relatingObject and relatedObjects from a relationship entity using byte-level scanning.
 * No TextDecoder needed - only extracts numeric entity IDs.
 */
export function extractRelFast(
    buffer: Uint8Array,
    byteOffset: number,
    byteLength: number,
    typeUpper: string,
): { relatingObject: number; relatedObjects: number[] } | null {
    const end = byteOffset + byteLength;
    let pos = byteOffset;

    while (pos < end && buffer[pos] !== 0x28) pos++;
    if (pos >= end) return null;
    pos++;

    // Skip to attr[4] (all IfcRelationship subtypes have 4 shared IfcRoot+IfcRelationship attrs)
    pos = skipCommas(buffer, pos, end, 4);

    if (typeUpper === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
        || typeUpper === 'IFCRELREFERENCEDINSPATIALSTRUCTURE'
        || typeUpper === 'IFCRELDEFINESBYPROPERTIES'
        || typeUpper === 'IFCRELDEFINESBYTYPE') {
        // attr[4]=RelatedObjects, attr[5]=RelatingObject
        const [related, rp] = readRefList(buffer, pos, end);
        pos = rp;
        while (pos < end && buffer[pos] !== 0x2C) pos++;
        pos++;
        const [relating, _] = readRefId(buffer, pos, end);
        if (relating < 0 || related.length === 0) return null;
        return { relatingObject: relating, relatedObjects: related };
    } else if (typeUpper === 'IFCRELASSIGNSTOGROUP' || typeUpper === 'IFCRELASSIGNSTOPRODUCT') {
        const [related, rp] = readRefList(buffer, pos, end);
        // `readRefList` returns `rp` pointing AT the closing `)` of
        // the list. `skipCommas` tracks paren depth, so leaving `rp`
        // there makes that `)` cancel the implicit depth-0 baseline
        // and subsequent commas don't count. Advance past it first.
        let after = rp;
        if (after < end && buffer[after] === 0x29) after++;
        pos = skipCommas(buffer, after, end, 2);
        const [relating, _] = readRefId(buffer, pos, end);
        if (relating < 0 || related.length === 0) return null;
        return { relatingObject: relating, relatedObjects: related };
    } else if (typeUpper === 'IFCRELCONNECTSPORTTOELEMENT' || typeUpper === 'IFCRELCONNECTSPORTS') {
        // attr[4]=RelatingPort, attr[5]=RelatedElement / RelatedPort — both
        // SINGLE references, and both at the front of the attribute list.
        //
        // Neither existing branch fits: the default one reads attr[5] as a
        // LIST, and the ConnectsElements branch skips one attribute first
        // because that entity carries an optional ConnectionGeometry at [4].
        // These two carry the port straight away. (`IfcRelConnectsPorts` also
        // has an optional RealizingElement at [6] — the element that realises
        // the connection, e.g. a piece of duct. Not read: it is a third party
        // to the connection, not one of its two ends, and an edge has two.)
        const [relating, rp] = readRefId(buffer, pos, end);
        if (relating < 0) return null;
        pos = skipCommas(buffer, rp, end, 1);
        const [related, _] = readRefId(buffer, pos, end);
        if (related < 0) return null;
        return { relatingObject: relating, relatedObjects: [related] };
    } else if (typeUpper === 'IFCRELCONNECTSELEMENTS' || typeUpper === 'IFCRELCONNECTSPATHELEMENTS') {
        pos = skipCommas(buffer, pos, end, 1);
        const [relating, rp2] = readRefId(buffer, pos, end);
        pos = skipCommas(buffer, rp2, end, 1);
        const [related, _] = readRefId(buffer, pos, end);
        if (relating < 0 || related < 0) return null;
        return { relatingObject: relating, relatedObjects: [related] };
    } else {
        // Default: attr[4]=RelatingObject, attr[5]=RelatedObject(s)
        const [relating, rp] = readRefId(buffer, pos, end);
        if (relating < 0) return null;
        pos = rp;
        while (pos < end && buffer[pos] !== 0x2C) pos++;
        pos++;
        const [related, _] = readRefList(buffer, pos, end);
        if (related.length === 0) return null;
        return { relatingObject: relating, relatedObjects: related };
    }
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
