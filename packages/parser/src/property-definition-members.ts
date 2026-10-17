/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from './columnar-parser.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { getInheritanceChain } from './ifc-schema.js';
import { propertyDefinitionRefsOfValue } from './property-definition-refs.js';

/**
 * The property definitions a DECODED `RelatingPropertyDefinition` names, checked
 * against the model. The one reader the readers that hold `entity.attributes[5]`
 * share (duplicate, native current type quantities), so they agree on a
 * malformed source (#7681).
 *
 * A decoded reference is a bare number, so inside a set `1500` and `#1500`
 * look alike, and `asRef`-style readers took both. A member of a set counts
 * here only when it names an entity of the effective model (not deleted) whose
 * class is an `IfcPropertySetDefinition` subtype (`IfcPropertySet`,
 * `IfcElementQuantity`, ...). A stray number then drops out, as it does in the
 * byte reader and in Rust, instead of becoming a dangling or wrong-typed
 * reference. What stays undetectable is a stray number that happens to equal
 * the id of another real property definition.
 *
 * A lone reference (not a set) keeps the caller's plain read: it is the
 * single-definition spelling every reader always took, and it is not
 * ambiguous with a scalar.
 *
 * `readRef` says what a reference looks like in the caller's values (default:
 * a positive integer). Written order, each definition once.
 */
export function propertyDefinitionsInModel(
    store: IfcDataStore,
    value: unknown,
    view?: MetadataReadView | null,
    readRef?: (member: unknown) => number | null,
): number[] {
    const guarded = Array.isArray(value)
        ? (member: unknown): number | null => {
            const id = readRef ? readRef(member) : (typeof member === 'number' && Number.isSafeInteger(member) && member > 0 ? member : null);
            if (id === null) return null;
            const record = effectiveMetadataRecord(store, id, view ?? undefined);
            return record && getInheritanceChain(record.type).includes('IfcPropertySetDefinition') ? id : null;
        }
        : readRef;
    return [...new Set(propertyDefinitionRefsOfValue(value, guarded))];
}
