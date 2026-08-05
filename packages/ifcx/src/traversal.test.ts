/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Composed-graph traversal and root/descendant queries.
 *
 * `traversal.ts` backs the geometry, point-cloud and entity extractors, and
 * `findRoots` / `getDescendants` are published from the package index, yet
 * neither module had a test file. These tests pin the parts that decide what
 * gets extracted: frame depth, incoming-edge de-duplication, the reachable
 * attribute index's cycle guard, and descendant de-duplication.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ComposedNode } from './types.js';
import { findRoots, getDescendants } from './composition.js';
import {
  buildReachableAttributeIndex,
  collectIncomingEdgeNames,
  findTraversalRoots,
  getFrameLineage,
  getNodeLineage,
  walkComposedFrames,
  type TraversalFrame,
} from './traversal.js';

/** Build a composed graph from an edge list: `parent --edgeName--> child`. */
function graph(
  edges: Array<[string, string, string]>,
  attributes: Record<string, Record<string, unknown>> = {},
  extraPaths: string[] = []
): Map<string, ComposedNode> {
  const nodes = new Map<string, ComposedNode>();
  const node = (path: string): ComposedNode => {
    let n = nodes.get(path);
    if (!n) {
      n = { path, attributes: new Map(), children: new Map() };
      nodes.set(path, n);
    }
    return n;
  };

  for (const p of extraPaths) node(p);
  for (const [parent, edgeName, child] of edges) {
    node(parent).children.set(edgeName, node(child));
  }
  for (const [path, attrs] of Object.entries(attributes)) {
    const n = node(path);
    for (const [k, v] of Object.entries(attrs)) n.attributes.set(k, v);
  }
  return nodes;
}

describe('findRoots / findTraversalRoots', () => {
  it('returns only the nodes never referenced as a child', () => {
    const composed = graph([
      ['root', 'a', 'child'],
      ['child', 'b', 'grandchild'],
    ]);

    assert.deepStrictEqual(
      findRoots(composed).map((n) => n.path),
      ['root']
    );
    assert.deepStrictEqual(
      findTraversalRoots(composed).map((n) => n.path),
      ['root']
    );
  });

  it('returns every node when nothing has children', () => {
    const composed = graph([], {}, ['a', 'b']);
    assert.deepStrictEqual(
      findRoots(composed).map((n) => n.path).sort(),
      ['a', 'b']
    );
  });

  it('returns no roots for a graph that is entirely a cycle', () => {
    const composed = graph([
      ['a', 'to-b', 'b'],
      ['b', 'to-a', 'a'],
    ]);
    assert.deepStrictEqual(findRoots(composed), []);
    assert.deepStrictEqual(findTraversalRoots(composed), []);
  });

  it('returns an empty list for an empty graph', () => {
    assert.deepStrictEqual(findRoots(new Map()), []);
  });
});

describe('getDescendants', () => {
  it('never repeats a node', () => {
    const composed = graph([
      ['root', 'left', 'l'],
      ['root', 'right', 'r'],
      ['l', 'down', 'shared'],
      ['r', 'down', 'shared'],
    ]);

    const paths = getDescendants(composed.get('root')!).map((n) => n.path);
    assert.strictEqual(new Set(paths).size, paths.length, 'descendants must be unique');
  });

  it('terminates on a cycle without re-listing the entry node', () => {
    const composed = graph([
      ['a', 'to-b', 'b'],
      ['b', 'to-a', 'a'],
    ]);

    // Without the visited guard the walk re-emits `a` as its own descendant.
    assert.deepStrictEqual(
      getDescendants(composed.get('a')!).map((n) => n.path),
      ['b']
    );
  });

  it('returns an empty list for a leaf', () => {
    const composed = graph([['root', 'x', 'leaf']]);
    assert.deepStrictEqual(getDescendants(composed.get('leaf')!), []);
  });
});

describe('collectIncomingEdgeNames', () => {
  it('records the edge name once when two parents use the same name', () => {
    const composed = graph([
      ['storey-1', 'contains', 'wall'],
      ['storey-2', 'contains', 'wall'],
    ]);

    assert.deepStrictEqual(collectIncomingEdgeNames(composed).get('wall'), ['contains']);
  });

  it('records each distinct edge name in first-seen order', () => {
    const composed = graph([
      ['a', 'body', 'geom'],
      ['b', 'axis', 'geom'],
      ['c', 'body', 'geom'],
    ]);

    assert.deepStrictEqual(collectIncomingEdgeNames(composed).get('geom'), ['body', 'axis']);
  });

  it('has no entry for a node nothing points at', () => {
    const composed = graph([['a', 'x', 'b']]);
    const incoming = collectIncomingEdgeNames(composed);
    assert.strictEqual(incoming.get('a'), undefined);
    assert.deepStrictEqual(incoming.get('b'), ['x']);
  });
});

describe('buildReachableAttributeIndex', () => {
  it('is true for the node holding the attribute and for its ancestors only', () => {
    const composed = graph(
      [
        ['root', 'a', 'mid'],
        ['mid', 'b', 'leaf'],
        ['root', 'c', 'other'],
      ],
      { leaf: { mesh: {} } }
    );

    const index = buildReachableAttributeIndex(composed, 'mesh');
    assert.strictEqual(index.get('leaf'), true);
    assert.strictEqual(index.get('mid'), true);
    assert.strictEqual(index.get('root'), true);
    assert.strictEqual(index.get('other'), false);
  });

  it('reports false for every node of an attribute-free cycle', () => {
    const composed = graph([
      ['a', 'to-b', 'b'],
      ['b', 'to-a', 'a'],
    ]);

    // The cycle guard must be a *negative* answer: treating a re-entered node
    // as a hit makes every node in any cycle claim it has geometry.
    const index = buildReachableAttributeIndex(composed, 'mesh');
    assert.strictEqual(index.get('a'), false);
    assert.strictEqual(index.get('b'), false);
  });

  it('still finds an attribute that lives inside a cycle', () => {
    const composed = graph(
      [
        ['a', 'to-b', 'b'],
        ['b', 'to-a', 'a'],
      ],
      { b: { mesh: {} } }
    );

    const index = buildReachableAttributeIndex(composed, 'mesh');
    assert.strictEqual(index.get('b'), true);
    assert.strictEqual(index.get('a'), true);
  });

  it('reports false when no node carries the attribute', () => {
    const composed = graph([['root', 'x', 'leaf']], { leaf: { other: 1 } });
    const index = buildReachableAttributeIndex(composed, 'mesh');
    assert.strictEqual(index.get('root'), false);
    assert.strictEqual(index.get('leaf'), false);
  });
});

describe('walkComposedFrames', () => {
  function collect(composed: Map<string, ComposedNode>): TraversalFrame[] {
    const frames: TraversalFrame[] = [];
    walkComposedFrames(composed, (f) => frames.push(f));
    return frames;
  }

  it('increments depth with each edge followed', () => {
    const composed = graph([
      ['root', 'a', 'mid'],
      ['mid', 'b', 'leaf'],
    ]);
    const byPath = new Map(collect(composed).map((f) => [f.node.path, f]));

    // Depth is what the extractors use to reason about nesting; a constant
    // depth flattens every lineage.
    assert.strictEqual(byPath.get('root')!.depth, 0);
    assert.strictEqual(byPath.get('mid')!.depth, 1);
    assert.strictEqual(byPath.get('leaf')!.depth, 2);
  });

  it('records the edge name and parent that led to each frame', () => {
    const composed = graph([['root', 'body', 'geom']]);
    const byPath = new Map(collect(composed).map((f) => [f.node.path, f]));

    assert.strictEqual(byPath.get('root')!.edgeName, null);
    assert.strictEqual(byPath.get('root')!.parent, null);
    assert.strictEqual(byPath.get('geom')!.edgeName, 'body');
    assert.strictEqual(byPath.get('geom')!.parent?.node.path, 'root');
  });

  it('visits a shared child once per incoming path', () => {
    const composed = graph([
      ['root', 'left', 'l'],
      ['root', 'right', 'r'],
      ['l', 'down', 'shared'],
      ['r', 'down', 'shared'],
    ]);

    const shared = collect(composed).filter((f) => f.node.path === 'shared');
    assert.strictEqual(shared.length, 2);
    assert.deepStrictEqual(
      shared.map((f) => getNodeLineage(f).map((n) => n.path)),
      [
        ['root', 'l', 'shared'],
        ['root', 'r', 'shared'],
      ]
    );
  });

  it('stops at a repeat on the current path rather than recursing forever', () => {
    const composed = graph([
      ['root', 'a', 'x'],
      ['x', 'b', 'y'],
      ['y', 'back', 'x'],
    ]);

    const paths = collect(composed).map((f) => f.node.path);
    assert.deepStrictEqual(paths, ['root', 'x', 'y']);
  });

  it('still reaches a component that is entirely a cycle', () => {
    const composed = graph([
      ['root', 'a', 'reachable'],
      ['orphan-a', 'to-b', 'orphan-b'],
      ['orphan-b', 'to-a', 'orphan-a'],
    ]);

    const paths = collect(composed).map((f) => f.node.path);
    assert.ok(paths.includes('orphan-a'), 'disconnected cycles must still be traversed');
    assert.ok(paths.includes('orphan-b'));
    assert.ok(paths.includes('reachable'));
  });

  it('visits nothing for an empty graph', () => {
    assert.deepStrictEqual(collect(new Map()), []);
  });
});

describe('getFrameLineage', () => {
  it('returns the chain from the seed down to the frame', () => {
    const composed = graph([
      ['root', 'a', 'mid'],
      ['mid', 'b', 'leaf'],
    ]);
    const frames: TraversalFrame[] = [];
    walkComposedFrames(composed, (f) => frames.push(f));
    const leaf = frames.find((f) => f.node.path === 'leaf')!;

    assert.deepStrictEqual(
      getFrameLineage(leaf).map((f) => f.node.path),
      ['root', 'mid', 'leaf']
    );
    assert.deepStrictEqual(
      getFrameLineage(leaf).map((f) => f.depth),
      [0, 1, 2]
    );
  });

  it('returns a single entry for a seed frame', () => {
    const composed = graph([], {}, ['solo']);
    const frames: TraversalFrame[] = [];
    walkComposedFrames(composed, (f) => frames.push(f));

    assert.deepStrictEqual(getNodeLineage(frames[0]).map((n) => n.path), ['solo']);
  });
});
