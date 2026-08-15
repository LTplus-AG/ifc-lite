/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Region footprints and a conflict predicate (Bet B1.4, docs/vision/
 * moonshots-execution-plan.md Phase 1 — "the M1-to-M4 handoff"; M4's kill
 * criterion, docs/vision/moonshots-execution-plan.md §5: "if footprint
 * tightening cannot get false-conflict rate below 20% on real traces,
 * provable merging is technically true but practically annoying").
 *
 * An {@link EditOp} declares what it writes two ways: `targetNodeIds` (the
 * DAG nodes it directly mutates — a pset leaf, a mesh leaf, an element node)
 * and, when geometry is involved, a world-space {@link Aabb} `region`.
 * {@link computeFootprint} turns that into a {@link Footprint}:
 * `writtenNodes` (the target set closed over ancestors — see the crux rule
 * below) and the (possibly absent) region. {@link conflictPredicate} then
 * decides whether two footprints conflict.
 *
 * ## The crux: which ancestors count as "written"
 *
 * The naive definition — `writtenNodes = target ∪ every ancestor via the
 * DAG's reverse edges` — is what dag-engine.ts's own `invalidate()` computes
 * for recompute purposes, and it is the WRONG definition for conflicts. Every
 * node in a Merkle DAG eventually has the same root ancestor, so under the
 * naive definition any two edits ANYWHERE in the model would share `root` (and
 * usually a storey relationship too) and register a structural conflict —
 * i.e. every edit would conflict with every other edit, which makes the
 * conflict predicate useless (100% false-conflict rate, an instant M4 kill).
 *
 * The fix: two node-hash-v0 kinds (`relationship`, `layer`) exist ONLY to
 * aggregate many independent children into one hash (a storey's
 * `IfcRelContainedInSpatialStructure` fan-in over its elements; the root
 * layer's fan-in over its storeys — see g1-memoized-recompute.mjs's DAG
 * shape and dag-engine.test.ts's fixed fixture, both of which build DAGs
 * with exactly this leaf -> element -> relationship -> layer shape). Editing
 * two different elements under the same storey both rewrite that storey's
 * hash and the root's hash, but they do so via two DISJOINT children — the
 * elements never actually interact, and applying both edits in either order
 * and recomputing the aggregator produces the same final hash (the
 * aggregators are commutative combines over their children's hashes).
 * Sharing an aggregator ancestor is therefore not evidence of conflict; it is
 * evidence that both ops happen to live in the same building.
 *
 * So `computeFootprint`'s ancestor walk STOPS at (and excludes) the first
 * `relationship`- or `layer`-kind ancestor it meets, and does not continue
 * walking past it (see {@link CONTAINER_KINDS}). Concretely, for the g1 DAG
 * shape: `writtenNodes(leaf) = {leaf, its element}` — never the storey, never
 * root. Two edits under different elements of the same storey then have
 * disjoint `writtenNodes` (no shared storey/root noise) and correctly do NOT
 * structurally conflict. Two edits to two different leaves of the SAME
 * element (e.g. a pset edit and a mesh edit on one wall) both include that
 * element's own node id in `writtenNodes`, so the intersection is non-empty
 * and they correctly DO conflict — "same element" is still caught, because
 * the element node itself is never a container kind and is never excluded.
 *
 * Caveat (honest scope limit, not a soundness gap against this module's own
 * definitions, but worth stating): an `EditOp` whose `targetNodeIds` names a
 * `relationship`/`layer` node DIRECTLY (e.g. a hypothetical op that reorders
 * a storey's element list) is added to `writtenNodes` as a target — targets
 * are never filtered, only ancestors are — but a concurrent edit to one of
 * that storey's elements will NOT see it, because the element-edit's own
 * ancestor walk excludes the storey node. Direct edits to container-kind
 * nodes are outside the `property-edit` / `geometry-edit` vocabulary this
 * file models and are not exercised by the tightness benchmark
 * (scripts/moonshot/g2-footprint-tightness.mjs); if a future op kind targets
 * containers directly, this rule needs revisiting.
 *
 * ## Spatial conflict and epsilon
 *
 * Independently of `writtenNodes`, two ops both carrying a `region` conflict
 * if their AABBs intersect after each is inflated by `epsilonMm` (world units
 * are metres throughout ifc-lite's authoring/geometry pipeline, so the
 * inflation is `epsilonMm / 1000` per axis). Default: {@link
 * DEFAULT_EPSILON_MM} = 50mm — not an arbitrary round number: it is the exact
 * clearance tolerance already load-bearing elsewhere in the M1 plan
 * (docs/vision/moonshots-tech.md §M1: "clearance to structure >= 50mm
 * everywhere" is the certificate-claim example given for geometric
 * invariants). Reusing it here means the spatial conflict test asks "are
 * these two edits closer than the minimum clearance this system already
 * promises elsewhere" — if two edits' regions come within 50mm of touching,
 * treating them as potentially conflicting is consistent with the rest of
 * the system's own tolerance vocabulary, not a second unrelated constant.
 */

import type { ProvenanceDag } from './dag-engine.js';
import type { GeometryMeshPayload, NodeKind } from './node-hash.js';

/** A world-space axis-aligned bounding box, metres, `[x, y, z]` per corner. */
export interface Aabb {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export type EditOpKind = 'property-edit' | 'geometry-edit';

/**
 * One edit against the DAG. `targetNodeIds` are the node ids the op directly
 * mutates (never ancestors — {@link computeFootprint} derives those).
 * `region` is a world-space box; per the task brief, property-only edits
 * carry no region (`undefined`), and geometry edits should derive theirs from
 * mesh origin+positions (see {@link aabbFromMesh} / {@link unionAabb}).
 */
export interface EditOp {
  opId: string;
  kind: EditOpKind;
  targetNodeIds: readonly string[];
  region?: Aabb;
}

/** The result of closing an {@link EditOp}'s targets over the DAG (see the
 *  module docstring's crux rule) plus its (possibly absent) region. */
export interface Footprint {
  opId: string;
  /** `targetNodeIds` ∪ their ancestors, STOPPING at (excluding) the first
   *  `relationship`/`layer`-kind ancestor on each path — see module
   *  docstring. */
  writtenNodes: ReadonlySet<string>;
  region: Aabb | null;
}

/** Node kinds that exist purely to aggregate many independent children into
 *  one hash (spatial-structure containment relationships, the root layer).
 *  Sharing one of these as an ancestor is never, by itself, a conflict — see
 *  the module docstring's crux rule. */
const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['relationship', 'layer']);

/** Ancestors of `nodeId`, stopping at (and excluding) the first
 *  container-kind ancestor on each upward path — the crux rule, isolated so
 *  {@link computeFootprint} can union it across every target. Does not
 *  include `nodeId` itself (the caller adds each target unconditionally). */
function ancestorsExcludingContainers(dag: ProvenanceDag, nodeId: string): Set<string> {
  const result = new Set<string>();
  const visited = new Set<string>([nodeId]);
  const stack: string[] = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const parentId of dag.getParents(id)) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      const kind = dag.getKind(parentId);
      if (kind !== undefined && CONTAINER_KINDS.has(kind)) {
        // Container/aggregation node: excluded from writtenNodes, and its
        // own ancestors are not walked either — everything above an
        // aggregator is more aggregation (see module docstring).
        continue;
      }
      result.add(parentId);
      stack.push(parentId);
    }
  }
  return result;
}

/**
 * Compute an op's footprint: its direct targets plus their ancestors
 * (excluding containers — the crux rule), and its region verbatim.
 * Every id in `op.targetNodeIds` must already exist in `dag` (thrown by
 * `dag.getParents`/`dag.getKind` otherwise is possible but this checks
 * explicitly first for a clearer error).
 */
export function computeFootprint(dag: ProvenanceDag, op: EditOp): Footprint {
  const writtenNodes = new Set<string>();
  for (const targetId of op.targetNodeIds) {
    if (!dag.has(targetId)) {
      throw new Error(`@ifc-lite/provenance: computeFootprint: unknown target node id "${targetId}"`);
    }
    writtenNodes.add(targetId);
    for (const ancestorId of ancestorsExcludingContainers(dag, targetId)) {
      writtenNodes.add(ancestorId);
    }
  }
  return { opId: op.opId, writtenNodes, region: op.region ?? null };
}

/** 50mm — see module docstring for why this specific value (it is the
 *  clearance-to-structure tolerance already named in the M1 midterm exam,
 *  docs/vision/moonshots-tech.md §M1). */
export const DEFAULT_EPSILON_MM = 50;

/** Inflate an AABB by `epsilonMm` per axis, per side (world units are
 *  metres; `epsilonMm / 1000` converts once here so every other function in
 *  this module works in metres like the rest of the geometry pipeline). */
export function inflateAabb(box: Aabb, epsilonMm: number): Aabb {
  const eps = epsilonMm / 1000;
  return {
    min: [box.min[0] - eps, box.min[1] - eps, box.min[2] - eps],
    max: [box.max[0] + eps, box.max[1] + eps, box.max[2] + eps],
  };
}

function aabbsIntersect(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/** Structural + spatial breakdown alongside the overall verdict, so callers
 *  (the tightness benchmark, tests) can tell WHICH rule fired. */
export interface ConflictResult {
  conflict: boolean;
  /** `writtenNodes` intersected (same element, same pset, or one op's target
   *  was an ancestor/descendant of the other's). */
  structural: boolean;
  /** Both ops carried a region and the epsilon-inflated boxes intersected. */
  spatial: boolean;
}

/**
 * Whether {@link conflictPredicate} evaluates its SPATIAL half at all.
 *
 * `'enabled'` is the predicate the system defines and the only configuration
 * under which a commutation certificate means anything. `'disabled'` — the
 * predicate reduced to structural overlap, spatial region intersection
 * ignored — exists for exactly one purpose: the **B4.2 ablation** (G4 red-team
 * review item 6, docs/vision/reviews/g4-red-team-2026-07-29.md §7).
 *
 * The soundness argument for the coupled op model (merge-model.ts module
 * docstring) *depends* on the spatial rule: a host and its openings overlap
 * spatially by construction, so every host-op/opening-op cross pair is refused
 * a certificate. An argument of that shape is only worth stating if turning
 * the rule off breaks it — so the battery runs the same 1,000 schedules with
 * this set to `'disabled'` and counts the cross pairs the reduced predicate
 * then CLEARS that do not actually commute (`runSpatialAblation` in
 * merge-battery.ts). This is a measuring instrument, never a production
 * configuration.
 */
export type SpatialRuleMode = 'enabled' | 'disabled';

export interface ConflictOptions {
  /** Default {@link DEFAULT_EPSILON_MM}. */
  epsilonMm?: number;
  /** Default `'enabled'`. `'disabled'` is the B4.2 ablation knob and makes
   *  the predicate structural-only — see {@link SpatialRuleMode}. */
  spatialRule?: SpatialRuleMode;
}

/**
 * SOUND conflict predicate (M4, docs/vision/moonshots-execution-plan.md §2
 * M4 risk 5 / §5 kill criterion): two ops conflict if (a) their
 * `writtenNodes` intersect — a structural conflict, computed per the module
 * docstring's crux rule so aggregator ancestors don't cause false positives
 * — or (b) both carry a region and the epsilon-inflated regions intersect —
 * a spatial conflict. Never returns `conflict: false` for two ops whose
 * `writtenNodes` (as this module defines them) actually intersect: (a) is a
 * plain set-intersection check with no early-out, so soundness holds by
 * construction. (b) may OVER-report (two spatially-close-but-unrelated
 * elements) — over-reporting is exactly what the tightness benchmark
 * measures, per the task brief ("may over-report, that is what tightness
 * measures").
 *
 * `options.spatialRule: 'disabled'` drops (b) entirely. That is an ABLATION,
 * not a tuning knob: under the coupled op model (merge-model.ts) it is
 * unsound by design, and measuring exactly how unsound is the point — see
 * {@link SpatialRuleMode}.
 */
export function conflictPredicate(
  fpA: Footprint,
  fpB: Footprint,
  options: ConflictOptions = {},
): ConflictResult {
  const epsilonMm = options.epsilonMm ?? DEFAULT_EPSILON_MM;
  const spatialRule = options.spatialRule ?? 'enabled';

  let structural = false;
  // Iterate the smaller set for a cheap constant-factor win; correctness
  // doesn't depend on which side we iterate.
  const [smaller, larger] =
    fpA.writtenNodes.size <= fpB.writtenNodes.size ? [fpA.writtenNodes, fpB.writtenNodes] : [fpB.writtenNodes, fpA.writtenNodes];
  for (const id of smaller) {
    if (larger.has(id)) {
      structural = true;
      break;
    }
  }

  let spatial = false;
  if (spatialRule === 'enabled' && fpA.region && fpB.region) {
    spatial = aabbsIntersect(inflateAabb(fpA.region, epsilonMm), inflateAabb(fpB.region, epsilonMm));
  }

  return { conflict: structural || spatial, structural, spatial };
}

/* ------------------------------------------------------------------ */
/* AABB helpers for building EditOp.region from real geometry-mesh leaves */
/* ------------------------------------------------------------------ */

/** World-space AABB of a `geometry-mesh` payload: fold `origin` into the
 *  (local-frame) `positions` triples, per the local-frame convention
 *  documented on {@link GeometryMeshPayload} and enforced elsewhere in the
 *  codebase (every local-frame consumer must fold `MeshData.origin`). Throws
 *  on an empty `positions` array (no bounds to compute). */
export function aabbFromMesh(mesh: GeometryMeshPayload): Aabb {
  const positions = mesh.positions;
  const length = positions.length;
  if (length < 3) {
    throw new Error('@ifc-lite/provenance: aabbFromMesh: positions must have at least one vertex (3 components)');
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const [ox, oy, oz] = mesh.origin;
  return {
    min: [minX + ox, minY + oy, minZ + oz],
    max: [maxX + ox, maxY + oy, maxZ + oz],
  };
}

/** Union of one or more AABBs — for an op whose region spans several mesh
 *  leaves (e.g. an element with multiple geometry-mesh children). */
export function unionAabb(boxes: readonly Aabb[]): Aabb {
  if (boxes.length === 0) {
    throw new Error('@ifc-lite/provenance: unionAabb: at least one box is required');
  }
  let minX = boxes[0].min[0];
  let minY = boxes[0].min[1];
  let minZ = boxes[0].min[2];
  let maxX = boxes[0].max[0];
  let maxY = boxes[0].max[1];
  let maxZ = boxes[0].max[2];
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.min[0] < minX) minX = b.min[0];
    if (b.min[1] < minY) minY = b.min[1];
    if (b.min[2] < minZ) minZ = b.min[2];
    if (b.max[0] > maxX) maxX = b.max[0];
    if (b.max[1] > maxY) maxY = b.max[1];
    if (b.max[2] > maxZ) maxZ = b.max[2];
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
