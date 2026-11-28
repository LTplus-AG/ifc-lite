/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RelationshipGraph, SpatialNode } from '@ifc-lite/data';
import { RelationshipType, isSpaceLikeSpatialType } from '@ifc-lite/data';

/** A storey with the spatial children it aggregates, recorded during the hierarchy walk. */
export interface SpaceClaim { storeyId: number; childNodes: SpatialNode[] }

/**
 * An element contained in a space a storey aggregates (or in a space nested in
 * it) is on that storey too, with its aggregated parts. The edited path
 * (`effectiveStoreyResolver`) already walks through the space; the parsed
 * model must answer the same. It runs once every storey has been visited so
 * direct containment, and the parts of a directly contained element, always
 * win whatever order the storeys were visited in. An element reached through
 * spaces on several storeys (a malformed file) goes to the lowest storey
 * express id, the same rule as `claim_through_spaces` in the Rust data model.
 */
export function claimThroughSpaces(
  spaceClaims: SpaceClaim[], relationships: RelationshipGraph, elementToStorey: Map<number, number>,
): void {
  spaceClaims.sort((a, b) => a.storeyId - b.storeyId);
  for (const { storeyId, childNodes } of spaceClaims) {
    const walk = (nodes: SpatialNode[]): void => {
      for (const node of nodes) {
        if (!isSpaceLikeSpatialType(node.type)) continue;
        for (const elementId of node.elements) {
          if (!elementToStorey.has(elementId)) elementToStorey.set(elementId, storeyId);
          const stack: number[] = [elementId];
          const seen = new Set<number>(stack);
          while (stack.length > 0) {
            for (const kid of relationships.getRelated(stack.pop() as number, RelationshipType.Aggregates, 'forward')) {
              if (seen.has(kid)) continue;
              seen.add(kid);
              if (!elementToStorey.has(kid)) elementToStorey.set(kid, storeyId);
              stack.push(kid);
            }
          }
        }
        walk(node.children);
      }
    };
    walk(childNodes);
  }
}
