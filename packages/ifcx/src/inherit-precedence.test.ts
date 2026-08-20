/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the precedence rule for multiple simultaneous `inherits` keys on
 * one node, and asserts composeIfcx (single-file) and composeFederated
 * (multi-layer) agree on it for the same input.
 *
 * Rule: when a node inherits from more than one path and both inherited
 * paths define the same attribute, the LAST-listed inherit wins. This
 * matches the buildingSMART reference composer (AddDataFromPreComposition
 * in IFC5-development/src/ifcx-core/composition/compose.ts), which
 * resolves `Object.values(input.inherits).forEach(...)` with `Map.set`
 * overwrites -- later entries win. composition.ts's composeNode already
 * implemented this; federated-composition.ts's resolveInheritance
 * previously implemented first-wins instead, so the two composers
 * disagreed on identical input (composeIfcx -> "B", composeFederated ->
 * "A"). Own (occurrence-level) attributes must still always beat any
 * inherited value, from either composer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { IfcxFile, IfcxNode } from './types.js';
import { composeIfcx } from './composition.js';
import { composeFederated } from './federated-composition.js';
import { createLayerStack } from './layer-stack.js';

function makeFile(data: IfcxNode[], id = 'test'): IfcxFile {
  return {
    header: {
      id,
      ifcxVersion: 'ifcx-alpha',
      dataVersion: '1',
      author: 'test',
      timestamp: '2026-06-09T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data,
  };
}

// Two base nodes with a conflicting attribute, and a child that inherits
// from both, in an order where naive first-wins and correct last-wins
// produce two DIFFERENT, observable results ("A" vs "B").
const conflictingInheritsNodes: IfcxNode[] = [
  { path: 'base-a', attributes: { 'test::value': 'A' } },
  { path: 'base-b', attributes: { 'test::value': 'B' } },
  {
    path: 'child',
    inherits: { first: 'base-a', second: 'base-b' },
  },
];

function composeWithFederated(nodes: IfcxNode[]) {
  const file = makeFile(nodes);
  const stack = createLayerStack();
  stack.addLayer(file, new ArrayBuffer(0), 'layer-1');
  return composeFederated(stack).composed;
}

describe('inherits precedence agrees across composers', () => {
  it('composeIfcx resolves multiple inherits with last-listed wins', () => {
    const composed = composeIfcx(makeFile(conflictingInheritsNodes));
    assert.strictEqual(composed.get('child')?.attributes.get('test::value'), 'B');
  });

  it('composeFederated resolves multiple inherits with last-listed wins', () => {
    const composed = composeWithFederated(conflictingInheritsNodes);
    assert.strictEqual(composed.get('child')?.attributes.get('test::value'), 'B');
  });

  it('composeIfcx and composeFederated agree on the same input', () => {
    const single = composeIfcx(makeFile(conflictingInheritsNodes));
    const federated = composeWithFederated(conflictingInheritsNodes);

    assert.strictEqual(
      single.get('child')?.attributes.get('test::value'),
      federated.get('child')?.attributes.get('test::value')
    );
  });

  it("own attributes still beat any inherited value, in both composers", () => {
    const nodesWithOwnOverride: IfcxNode[] = [
      ...conflictingInheritsNodes.slice(0, 2),
      {
        path: 'child',
        inherits: { first: 'base-a', second: 'base-b' },
        attributes: { 'test::value': 'own' },
      },
    ];

    const single = composeIfcx(makeFile(nodesWithOwnOverride));
    const federated = composeWithFederated(nodesWithOwnOverride);

    assert.strictEqual(single.get('child')?.attributes.get('test::value'), 'own');
    assert.strictEqual(federated.get('child')?.attributes.get('test::value'), 'own');
  });
});
