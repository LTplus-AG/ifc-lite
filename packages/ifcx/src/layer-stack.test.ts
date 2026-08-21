/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LayerStack manages an ORDERED array where order is the entire semantics
 * (strength/precedence in USD-style composition). A fixture with a single
 * layer, or with layers whose paths never overlap, cannot observe ordering
 * at all -- every test below uses at least two (usually three) layers that
 * each carry a node at the SAME path, so ordering, insertion position, and
 * filtering are all genuinely exercised.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LayerStack, createLayerStack } from './layer-stack.js';
import type { IfcxFile, IfcxNode } from './types.js';

function makeFile(nodes: IfcxNode[]): IfcxFile {
  return {
    header: {
      id: 'test',
      ifcxVersion: '5.0',
      dataVersion: '1',
      author: 'test',
      timestamp: '2026-01-01T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data: nodes,
  };
}

/** A layer whose only node lives at 'wall1', tagged so we can identify which layer's opinion won/appears where. */
function contestingLayer(tag: string, path = 'wall1'): { file: IfcxFile; buffer: ArrayBuffer } {
  const file = makeFile([{ path, attributes: { tag } }]);
  return { file, buffer: new ArrayBuffer(0) };
}

function addTagged(stack: LayerStack, tag: string, path = 'wall1'): string {
  const { file, buffer } = contestingLayer(tag, path);
  return stack.addLayer(file, buffer, tag);
}

function tags(stack: LayerStack): string[] {
  return stack.getLayers().map((l) => l.name);
}

describe('LayerStack — ordering and precedence', () => {
  it('addLayer inserts new layers at the strongest (index 0) position, not the end', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');
    addTagged(stack, 'C');

    // C was added last and must be strongest: most-recently-added wins.
    assert.deepStrictEqual(tags(stack), ['C', 'B', 'A']);
  });

  it('assigns strength = index after every insert (0 is strongest)', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');
    addTagged(stack, 'C');

    const strengths = stack.getLayers().map((l) => l.strength);
    assert.deepStrictEqual(strengths, [0, 1, 2]);
  });

  it('getNodesForPath returns contesting layers strongest-first for a path every layer defines', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');
    addTagged(stack, 'C');

    const results = stack.getNodesForPath('wall1');
    assert.deepStrictEqual(
      results.map((r) => r.layer.name),
      ['C', 'B', 'A'],
      'strongest (most recently added) layer must be listed first'
    );
    // Each result actually carries THAT layer's own opinion, not a mixed-up one.
    assert.deepStrictEqual(
      results.map((r) => (r.nodes[0].attributes as { tag: string }).tag),
      ['C', 'B', 'A']
    );
  });

  it('addLayerAt splices into the middle of the stack, not onto an end', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A'); // -> [A]
    addTagged(stack, 'B'); // -> [B, A]
    const { file, buffer } = contestingLayer('MID');
    stack.addLayerAt(file, buffer, 'MID', 1); // -> [B, MID, A]

    assert.deepStrictEqual(tags(stack), ['B', 'MID', 'A']);
    assert.deepStrictEqual(
      stack.getLayers().map((l) => l.strength),
      [0, 1, 2]
    );
  });

  it('addLayerAt clamps an out-of-range position to the nearest valid slot', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');

    const { file: f1, buffer: b1 } = contestingLayer('TOO_FAR');
    stack.addLayerAt(f1, b1, 'TOO_FAR', 999);
    assert.deepStrictEqual(tags(stack), ['B', 'A', 'TOO_FAR'], 'clamped to the end');

    const { file: f2, buffer: b2 } = contestingLayer('NEGATIVE');
    stack.addLayerAt(f2, b2, 'NEGATIVE', -5);
    assert.deepStrictEqual(tags(stack), ['NEGATIVE', 'B', 'A', 'TOO_FAR'], 'clamped to the start');
  });

  it('moveLayer relocates a layer and renumbers strengths for everyone', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A'); // eventually index 2
    addTagged(stack, 'B'); // eventually index 1
    addTagged(stack, 'C'); // eventually index 0
    // Stack is [C, B, A]. Move A (bottom, weakest) to the top.
    const aId = stack.getLayers().find((l) => l.name === 'A')!.id;
    const moved = stack.moveLayer(aId, 0);

    assert.strictEqual(moved, true);
    assert.deepStrictEqual(tags(stack), ['A', 'C', 'B']);
    assert.deepStrictEqual(
      stack.getLayers().map((l) => l.strength),
      [0, 1, 2]
    );
  });

  it('moveLayer clamps the target position within bounds', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');
    addTagged(stack, 'C'); // [C, B, A]
    const cId = stack.getLayers().find((l) => l.name === 'C')!.id;

    stack.moveLayer(cId, 999);
    assert.deepStrictEqual(tags(stack), ['B', 'A', 'C'], 'clamped to the last valid index');
  });

  it('moveLayer returns false and leaves the stack untouched for an unknown id', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');
    const before = tags(stack);

    const moved = stack.moveLayer('does-not-exist', 0);
    assert.strictEqual(moved, false);
    assert.deepStrictEqual(tags(stack), before);
  });

  it('removeLayer renumbers the strengths of layers that shift up', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');
    addTagged(stack, 'C'); // [C, B, A], strengths 0,1,2
    const bId = stack.getLayers().find((l) => l.name === 'B')!.id;

    const removed = stack.removeLayer(bId);
    assert.strictEqual(removed, true);
    assert.deepStrictEqual(tags(stack), ['C', 'A']);
    assert.deepStrictEqual(
      stack.getLayers().map((l) => l.strength),
      [0, 1],
      'A shifts from strength 2 down to 1 once B is removed'
    );
  });

  it('reorderLayers applies exactly the given order, drops omitted ids, and ignores unknown ids', () => {
    const stack = createLayerStack();
    const aId = addTagged(stack, 'A');
    const bId = addTagged(stack, 'B');
    const cId = addTagged(stack, 'C'); // [C, B, A]

    stack.reorderLayers([aId, cId, 'unknown-id', bId]);
    // B and C both survive but A must lead per the new order; 'unknown-id' is ignored.
    assert.deepStrictEqual(tags(stack), ['A', 'C', 'B']);
    assert.deepStrictEqual(
      stack.getLayers().map((l) => l.strength),
      [0, 1, 2]
    );
  });

  it('reorderLayers drops any layer id missing from the new order', () => {
    const stack = createLayerStack();
    const aId = addTagged(stack, 'A');
    addTagged(stack, 'B');
    const cId = addTagged(stack, 'C'); // [C, B, A]

    stack.reorderLayers([cId, aId]); // B omitted
    assert.deepStrictEqual(tags(stack), ['C', 'A']);
    assert.strictEqual(stack.count, 2);
  });
});

describe('LayerStack — enabled/disabled filtering', () => {
  it('getEnabledLayers and getNodesForPath skip a disabled middle layer but keep stack order for the rest', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    const bId = addTagged(stack, 'B');
    addTagged(stack, 'C'); // [C, B, A]

    stack.setLayerEnabled(bId, false);

    assert.deepStrictEqual(
      stack.getEnabledLayers().map((l) => l.name),
      ['C', 'A'],
      'disabled B excluded, C/A order preserved'
    );
    assert.deepStrictEqual(
      stack.getNodesForPath('wall1').map((r) => r.layer.name),
      ['C', 'A']
    );
    // The full (unfiltered) stack still has all three, in original order.
    assert.deepStrictEqual(tags(stack), ['C', 'B', 'A']);
  });

  it('toggleLayer flips enabled state each call', () => {
    const stack = createLayerStack();
    const aId = addTagged(stack, 'A');

    assert.strictEqual(stack.getLayer(aId)!.enabled, true);
    stack.toggleLayer(aId);
    assert.strictEqual(stack.getLayer(aId)!.enabled, false);
    stack.toggleLayer(aId);
    assert.strictEqual(stack.getLayer(aId)!.enabled, true);
  });

  it('hasPath is true only via an enabled layer', () => {
    const stack = createLayerStack();
    const aId = addTagged(stack, 'A', 'onlyInA');

    assert.strictEqual(stack.hasPath('onlyInA'), true);
    stack.setLayerEnabled(aId, false);
    assert.strictEqual(stack.hasPath('onlyInA'), false);
  });

  it('getAllPaths unions paths across enabled layers only, deduplicated', () => {
    const stack = createLayerStack();
    const aId = addTagged(stack, 'A', 'pathX');
    addTagged(stack, 'B', 'pathX'); // same path, contests A
    addTagged(stack, 'C', 'pathY');

    assert.deepStrictEqual([...stack.getAllPaths()].sort(), ['pathX', 'pathY']);

    stack.setLayerEnabled(aId, false);
    // pathX is still visible via layer B.
    assert.deepStrictEqual([...stack.getAllPaths()].sort(), ['pathX', 'pathY']);
  });

  it('getStats counts nodes and unique paths over enabled layers only', () => {
    const stack = createLayerStack();
    const aId = addTagged(stack, 'A', 'pathX');
    addTagged(stack, 'B', 'pathX');
    addTagged(stack, 'C', 'pathY');

    let stats = stack.getStats();
    assert.strictEqual(stats.layerCount, 3);
    assert.strictEqual(stats.enabledCount, 3);
    assert.strictEqual(stats.totalNodes, 3);
    assert.strictEqual(stats.uniquePaths, 2);

    stack.setLayerEnabled(aId, false);
    stats = stack.getStats();
    assert.strictEqual(stats.layerCount, 3, 'layerCount is unaffected by enabled state');
    assert.strictEqual(stats.enabledCount, 2);
    assert.strictEqual(stats.totalNodes, 2);
    assert.strictEqual(stats.uniquePaths, 2, 'pathX still counted once via layer B');
  });
});

describe('LayerStack — basic bookkeeping', () => {
  it('starts empty', () => {
    const stack = createLayerStack();
    assert.strictEqual(stack.isEmpty, true);
    assert.strictEqual(stack.count, 0);
  });

  it('clear() empties a populated stack', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    addTagged(stack, 'B');
    assert.strictEqual(stack.count, 2);

    stack.clear();
    assert.strictEqual(stack.isEmpty, true);
    assert.strictEqual(stack.count, 0);
  });

  it('removeLayer returns false for an unknown id and does not disturb the stack', () => {
    const stack = createLayerStack();
    addTagged(stack, 'A');
    const removed = stack.removeLayer('nope');
    assert.strictEqual(removed, false);
    assert.strictEqual(stack.count, 1);
  });
});
