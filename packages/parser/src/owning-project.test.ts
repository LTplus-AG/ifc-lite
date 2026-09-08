/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { resolveOwningIfcProjectId } from './owning-project.js';

type EdgeKey = `${number}:${RelationshipType}:${'forward' | 'inverse'}`;

function resolve(edges: Partial<Record<EdgeKey, number[]>>, expressId: number): number | undefined {
  return resolveOwningIfcProjectId(
    { byId: new Map(), byType: new Map([['IFCPROJECT', [1, 101]]]) },
    { getRelated: (id, type, direction) => edges[`${id}:${type}:${direction}`] ?? [] },
    expressId,
  );
}

describe('resolveOwningIfcProjectId (#3554, #3555)', () => {
  it('follows actual containment before an unrelated type edge in a federated file', () => {
    const edges: Partial<Record<EdgeKey, number[]>> = {
      [`200:${RelationshipType.ContainsElements}:inverse`]: [210],
      [`210:${RelationshipType.Aggregates}:inverse`]: [220],
      [`220:${RelationshipType.Aggregates}:inverse`]: [101],
      [`200:${RelationshipType.DefinesByType}:forward`]: [300],
      [`300:${RelationshipType.ContainsElements}:inverse`]: [310],
      [`310:${RelationshipType.Aggregates}:inverse`]: [1],
    };

    expect(resolve(edges, 200)).toBe(101);
  });

  it('is not exhausted by a type used by many occurrences', () => {
    // The shape both P1 review threads on #3578 reported: an IfcTypeProduct
    // used by dozens of occurrences in a federated file. Resolution must not
    // depend on the fan-out -- a walk bounded by items INSPECTED rather than
    // hops TAKEN would enqueue every occurrence before reaching any
    // occurrence's container, exhaust its budget, and report "no owner" for a
    // valid ownership path, sending the caller to the FIRST project's units.
    // Following one chain reaches the project in three hops at any width.
    const occurrences = Array.from({ length: 100 }, (_, i) => 1000 + i);
    const edges: Partial<Record<EdgeKey, number[]>> = {
      [`400:${RelationshipType.DefinesByType}:forward`]: occurrences,
      [`420:${RelationshipType.Aggregates}:inverse`]: [101],
    };
    for (const id of occurrences) edges[`${id}:${RelationshipType.ContainsElements}:inverse`] = [420];

    expect(resolve(edges, 400)).toBe(101);
  });

  it('uses an occurrence to locate a type-owned value and terminates on a cycle', () => {
    const typeEdges: Partial<Record<EdgeKey, number[]>> = {
      [`400:${RelationshipType.DefinesByType}:forward`]: [410],
      [`410:${RelationshipType.ContainsElements}:inverse`]: [420],
      [`420:${RelationshipType.Aggregates}:inverse`]: [101],
    };
    const cycleEdges: Partial<Record<EdgeKey, number[]>> = {
      [`500:${RelationshipType.Aggregates}:inverse`]: [510],
      [`510:${RelationshipType.Aggregates}:inverse`]: [500],
    };

    expect(resolve(typeEdges, 400)).toBe(101);
    expect(resolve(cycleEdges, 500)).toBeUndefined();
  });
});
