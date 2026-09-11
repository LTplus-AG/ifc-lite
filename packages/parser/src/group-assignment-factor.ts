/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { extractAllEntityAttributes } from './columnar-parser-root-attributes.js';

/**
 * The proportional `Factor` of a group/zone member assigned through
 * `IfcRelAssignsToGroupByFactor`, or `undefined` for a plain
 * `IfcRelAssignsToGroup` assignment (no `Factor` attribute) or no
 * assignment at all. The edge itself carries no attribute payload, so this
 * resolves the edge's `relationshipId` under the distinct
 * {@link RelationshipType.AssignsToGroupByFactor} bucket and reads `Factor`
 * off that (already-queryable) relationship entity via
 * {@link extractAllEntityAttributes} (#4205).
 */
export function extractGroupAssignmentFactorOnDemand(
    store: IfcDataStore,
    groupId: number,
    memberId: number
): number | undefined {
    if (!store.relationships) return undefined;
    const edges = store.relationships.forward.getEdges(groupId, RelationshipType.AssignsToGroupByFactor);
    for (const edge of edges) {
        if (edge.target !== memberId) continue;
        const attrs = extractAllEntityAttributes(store, edge.relationshipId);
        const factorAttr = attrs.find((a) => a.name === 'Factor');
        if (factorAttr && typeof factorAttr.value === 'number') return factorAttr.value;
    }
    return undefined;
}
