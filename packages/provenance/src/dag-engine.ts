/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Incremental DAG engine for node-hash-v0 (docs/vision/spec/node-hash-v0.md,
 * Bet B1.1, M1 midterm: "memoized recompute through the void-router graph;
 * cache-hit telemetry on real edit traces").
 *
 * `ProvenanceDag` is a thin, store-agnostic wrapper over {@link computeNodeHash}
 * (`./node-hash.js`) that adds the piece G0's demo hand-rolled per-script
 * (`scripts/moonshot/g0-certificate-demo.mjs`'s `propagateStoreyAndRoot` /
 * `applyElementEdit`): a general dependency graph so a caller doesn't have to
 * hand-write "which ancestors does this leaf feed" propagation logic for
 * every DAG shape.
 *
 * A node is either:
 * - a **leaf**: a literal payload with no DAG children (`geometry-mesh`,
 *   `property-set` in practice, though nothing here enforces that mapping —
 *   any kind can be a leaf if its payload doesn't reference other nodes).
 * - a **composite**: a list of child node ids plus a `buildPayload` function
 *   that assembles the kind's payload once every child's CURRENT hash is
 *   known (mirrors spec §3.2's "a child-hash reference is encoded as a
 *   string field holding the child's tagged hash string").
 *
 * `invalidate(nodeIds)` marks the given nodes dirty and transitively marks
 * every ancestor dirty too (a child's hash may have changed, so every node
 * whose canonical bytes embed that child's hash string must be re-derived to
 * find out). `recompute()` then walks ONLY the dirty set, in dependency
 * order, and reports `{ recomputed, cacheHits, hitRate }` telemetry. Nodes
 * never touched by `computeAndStoreHash` in a `recompute()` call are cache
 * hits by construction — this file never re-hashes a node it doesn't have to.
 */

import { computeNodeHash, type NodeKind, type PayloadForKind } from './node-hash.js';

/** A node whose hash is a literal function of its own payload — no DAG
 *  children. `geometry-mesh` and `property-set` payloads never reference
 *  other nodes, so they are always leaves in practice, but this is a runtime
 *  distinction (presence of `payload` vs `buildPayload`), not a type-level
 *  restriction to those two kinds. */
export interface LeafNodeSpec<K extends NodeKind = NodeKind> {
  id: string;
  kind: K;
  payload: PayloadForKind<K>;
}

/** A node whose payload is assembled from its children's CURRENT hashes.
 *  `buildPayload` is called with a map from child id to that child's
 *  currently-stored hash (already up to date, since children are always
 *  processed before parents — see {@link ProvenanceDag.build}). */
export interface CompositeNodeSpec<K extends NodeKind = NodeKind> {
  id: string;
  kind: K;
  /** DAG edges: every node id this node's payload references. Order does not
   *  matter to the engine (node-hash-v0's own composite encodings sort their
   *  child references before hashing, spec §3.2) but IS passed through
   *  verbatim to `buildPayload` via the map keys, so callers can iterate
   *  `children` in whatever order they authored it. */
  children: readonly string[];
  buildPayload: (childHashes: ReadonlyMap<string, string>) => PayloadForKind<K>;
}

export type NodeSpec<K extends NodeKind = NodeKind> = LeafNodeSpec<K> | CompositeNodeSpec<K>;

function isComposite(spec: NodeSpec): spec is CompositeNodeSpec {
  return 'buildPayload' in spec;
}

/** Shared frozen empty set returned by {@link ProvenanceDag.getParents} for a
 *  node with no recorded parent edges (e.g. a DAG root) — avoids allocating a
 *  fresh empty Set on every such call. */
const EMPTY_PARENT_SET: ReadonlySet<string> = new Set();

interface InternalNode {
  id: string;
  kind: NodeKind;
  children: readonly string[];
  payload?: unknown;
  buildPayload?: (childHashes: ReadonlyMap<string, string>) => unknown;
  hash?: string;
}

/** Telemetry for one `recompute()` call (spec-required shape:
 *  `{recomputed, cacheHits, hitRate}`, plus a few fields useful for
 *  debugging/scorecards that don't change the contract). */
export interface RecomputeTelemetry {
  /** Nodes whose hash was actually recomputed this call (the dirty set, in
   *  dependency order). */
  recomputed: number;
  /** `totalNodes - recomputed` — nodes whose hash was reused as-is. */
  cacheHits: number;
  /** `cacheHits / totalNodes` (1 when the DAG is empty). */
  hitRate: number;
  /** Total node count in the DAG at the time of this call. */
  totalNodes: number;
  /** The ids that were recomputed, in the order they were processed
   *  (children before parents). */
  recomputedNodeIds: readonly string[];
  /** Wall-clock time this `recompute()` call took, milliseconds. */
  elapsedMs: number;
}

/**
 * Dependency-tracked, memoized Merkle DAG over node-hash-v0 nodes.
 *
 * Lifecycle: `addNode` every node (any order — a forward reference to a
 * child id that gets added later is fine, since `build()` topologically
 * sorts before hashing anything), call `build()` once to hash the whole DAG
 * from scratch, then repeatedly `setPayload`/`setBuildPayload` (which
 * implicitly `invalidate`s) followed by `recompute()` to apply an edit and
 * get its cache-hit telemetry.
 */
export class ProvenanceDag {
  private readonly nodes = new Map<string, InternalNode>();
  /** child id -> set of node ids that reference it as a child. Maintained
   *  incrementally in `addNode` so `invalidate` never has to rescan the DAG. */
  private readonly parents = new Map<string, Set<string>>();
  private topoOrder: readonly string[] = [];
  private readonly dirty = new Set<string>();
  private built = false;

  /** Register a node. Must be called before {@link build}; adding a node
   *  after `build()` invalidates the cached topological order and requires
   *  calling `build()` again (a structural change, not an edit — this engine
   *  intentionally does not try to incrementally patch the topology itself,
   *  only payload changes on the existing topology). */
  addNode(spec: NodeSpec): void {
    if (this.nodes.has(spec.id)) {
      throw new Error(`ProvenanceDag: duplicate node id "${spec.id}"`);
    }
    const children = isComposite(spec) ? spec.children : [];
    const node: InternalNode = {
      id: spec.id,
      kind: spec.kind,
      children,
      ...(isComposite(spec) ? { buildPayload: spec.buildPayload } : { payload: spec.payload }),
    };
    this.nodes.set(spec.id, node);
    for (const childId of children) {
      let set = this.parents.get(childId);
      if (!set) {
        set = new Set();
        this.parents.set(childId, set);
      }
      set.add(spec.id);
    }
    this.built = false;
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  get size(): number {
    return this.nodes.size;
  }

  nodeIds(): IterableIterator<string> {
    return this.nodes.keys();
  }

  getKind(nodeId: string): NodeKind | undefined {
    return this.nodes.get(nodeId)?.kind;
  }

  /** Ids of nodes that directly reference `nodeId` as a child — the
   *  reverse-edge parent set this engine already maintains incrementally in
   *  {@link addNode} for `invalidate`'s ancestor cascade. Read-only: never
   *  marks anything dirty, unlike `invalidate`. Returns an empty (frozen,
   *  shared) set for a node with no parents (e.g. a DAG root). Exposed
   *  primarily for `footprint.ts`'s ancestor walks, which need policy this
   *  generic engine deliberately does not know about (which ancestor KINDS
   *  count as a "write" for conflict purposes) — see that file's module
   *  docstring for the full rationale. Throws on an unregistered node id,
   *  same as every other by-id accessor on this class. */
  getParents(nodeId: string): ReadonlySet<string> {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`ProvenanceDag: getParents: unknown node id "${nodeId}"`);
    }
    return this.parents.get(nodeId) ?? EMPTY_PARENT_SET;
  }

  /** The node's currently-stored hash, or `undefined` if it has never been
   *  hashed (before the first `build()`). */
  getHash(nodeId: string): string | undefined {
    return this.nodes.get(nodeId)?.hash;
  }

  /** A snapshot of every node's current hash — the primary tool for
   *  correctness cross-checks (compare an incrementally-recomputed DAG's
   *  snapshot to a freshly-built one over the same final payloads). */
  snapshot(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const [id, node] of this.nodes) {
      if (node.hash !== undefined) out.set(id, node.hash);
    }
    return out;
  }

  private computeTopoOrder(): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`ProvenanceDag: cycle detected at node "${id}"`);
      }
      const node = this.nodes.get(id);
      if (!node) {
        throw new Error(`ProvenanceDag: node references unknown child id "${id}"`);
      }
      visiting.add(id);
      for (const childId of node.children) visit(childId);
      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };
    for (const id of this.nodes.keys()) visit(id);
    return order;
  }

  private async computeAndStoreHash(id: string): Promise<string> {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`ProvenanceDag: unknown node id "${id}"`);
    let payload: unknown;
    if (node.buildPayload) {
      const childHashes = new Map<string, string>();
      for (const childId of node.children) {
        const childHash = this.nodes.get(childId)?.hash;
        if (childHash === undefined) {
          throw new Error(
            `ProvenanceDag: child "${childId}" of "${id}" has no hash yet (build-order bug — ` +
              `children must be hashed before their parents)`,
          );
        }
        childHashes.set(childId, childHash);
      }
      payload = node.buildPayload(childHashes);
    } else {
      payload = node.payload;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload's real shape is
    // PayloadForKind<node.kind>, erased to `unknown` by the internal storage; computeNodeHash's
    // own overload set re-establishes the kind<->payload pairing at the call site.
    const hash = await computeNodeHash(node.kind as any, payload as any);
    node.hash = hash;
    return hash;
  }

  /** Hash every node from scratch, in dependency order. Use once at DAG
   *  construction time (or whenever you want a from-scratch cross-check —
   *  building a second `ProvenanceDag` with the same specs and calling
   *  `build()` on it never reuses the first instance's state). */
  async build(): Promise<void> {
    this.topoOrder = this.computeTopoOrder();
    for (const id of this.topoOrder) {
      await this.computeAndStoreHash(id);
    }
    this.dirty.clear();
    this.built = true;
  }

  /** Replace a leaf node's payload (a node added with `payload`, not
   *  `buildPayload`) and mark it — and every ancestor — dirty. Does not
   *  recompute anything; call `recompute()` afterward. */
  setPayload<K extends NodeKind>(nodeId: string, payload: PayloadForKind<K>): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`ProvenanceDag: unknown node id "${nodeId}"`);
    if (node.buildPayload) {
      throw new Error(
        `ProvenanceDag: node "${nodeId}" is composite (has children/buildPayload); use setBuildPayload`,
      );
    }
    node.payload = payload;
    this.invalidate([nodeId]);
  }

  /** Replace a composite node's `buildPayload` (e.g. its own non-child fields
   *  changed — a relationship's `relType`, a layer's `layerId`). Marks the
   *  node — and every ancestor — dirty. */
  setBuildPayload<K extends NodeKind>(
    nodeId: string,
    buildPayload: (childHashes: ReadonlyMap<string, string>) => PayloadForKind<K>,
  ): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`ProvenanceDag: unknown node id "${nodeId}"`);
    if (!node.buildPayload) {
      throw new Error(`ProvenanceDag: node "${nodeId}" is a leaf (has a literal payload); use setPayload`);
    }
    node.buildPayload = buildPayload as (childHashes: ReadonlyMap<string, string>) => unknown;
    this.invalidate([nodeId]);
  }

  /**
   * Mark the given node ids dirty, and transitively mark every ancestor
   * dirty too (BFS over the reverse-edge `parents` map). Idempotent —
   * invalidating an already-dirty node (or one of its ancestors) is a no-op
   * for that node. Safe to call multiple times before a single `recompute()`
   * (e.g. a batch of leaf edits applied together).
   */
  invalidate(nodeIds: readonly string[]): void {
    const stack = [...nodeIds];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (!this.nodes.has(id)) {
        throw new Error(`ProvenanceDag: invalidate: unknown node id "${id}"`);
      }
      if (this.dirty.has(id)) continue;
      this.dirty.add(id);
      const parentIds = this.parents.get(id);
      if (parentIds) {
        for (const parentId of parentIds) stack.push(parentId);
      }
    }
  }

  /** How many nodes are currently dirty (pending recompute). Exposed mainly
   *  for tests/telemetry previews before actually paying for `recompute()`. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /**
   * Recompute exactly the dirty set — every node invalidated since the last
   * `build()`/`recompute()` call, plus their ancestors (already folded in by
   * `invalidate`) — in dependency order, and report cache-hit telemetry.
   * Every node NOT in the dirty set keeps its previously-computed hash
   * untouched: that's the memoization.
   */
  async recompute(): Promise<RecomputeTelemetry> {
    if (!this.built) {
      throw new Error('ProvenanceDag: call build() before recompute() (no baseline to invalidate against)');
    }
    const start = performance.now();
    const recomputedNodeIds = this.topoOrder.filter((id) => this.dirty.has(id));
    for (const id of recomputedNodeIds) {
      await this.computeAndStoreHash(id);
    }
    this.dirty.clear();
    const elapsedMs = performance.now() - start;

    const totalNodes = this.nodes.size;
    const recomputed = recomputedNodeIds.length;
    const cacheHits = totalNodes - recomputed;
    const hitRate = totalNodes === 0 ? 1 : cacheHits / totalNodes;
    return { recomputed, cacheHits, hitRate, totalNodes, recomputedNodeIds, elapsedMs };
  }
}
