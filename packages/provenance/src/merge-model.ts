/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal deterministic op model for the M4 merge soundness contract
 * (Bet B2.1, docs/vision/moonshots-execution-plan.md Phase 2; M4 midterm
 * exam: "soundness property test, 1,000 randomized two-client op schedules,
 * zero unsound auto-merges").
 *
 * footprint.ts declares WHAT an op touches (`EditOp`: target node ids plus an
 * optional world-space region) but deliberately has no semantics -- nothing
 * in B1.4 could apply an op. This module supplies the missing half: a
 * concrete, deterministic model state plus four op kinds (entity add/remove,
 * attr-set, geometry-replace, per the task brief) whose application is a pure
 * function of (state, op). "Byte-identical under the deterministic kernel
 * model" is made literal by {@link canonicalStateBytes}: a canonical,
 * order-insensitive serialization of the state, standing in for the kernel's
 * deterministic output bytes (the real kernel is deterministic by the
 * mesh-determinism manifest; this model inherits the property by
 * construction). Two replicas converge iff their canonical bytes are equal;
 * the Merkle commitment for certificates is {@link hashModelState}, the
 * node-hash-v0 root hash of the state's DAG (same leaf -> element -> storey
 * relationship -> root layer shape as g1/g2 and dag-engine.test.ts).
 *
 * Footprints reuse footprint.ts verbatim for ops whose targets exist in the
 * base DAG (remove/attr-set/geometry-replace); `entity-add` targets ids that
 * do not exist yet, so {@link computeMergeOpFootprint} builds its footprint
 * directly from the op's own fresh node ids (two adds conflict iff they claim
 * the same ids or their regions collide -- exactly the right semantics).
 *
 * ## Spatially coupled semantics (Bet B4.2)
 *
 * v0 of this model applied every op purely per-node: an op read and wrote one
 * node's payload and nothing else. That made node-disjoint ops commute
 * BY CONSTRUCTION -- no schedule could ever fail because of geometry -- which
 * the G2 red-team review (docs/vision/reviews/g2-red-team-2026-07-24.md §4)
 * showed empirically: in 1,000 schedules the spatial half of the conflict
 * predicate produced 35 false conflicts and ZERO true ones, because the op
 * model could not represent the hazard the rule exists for.
 *
 * This version gives the model one real spatial coupling, the smallest one
 * that is unambiguously real in IFC: **hosted openings**. An entity may carry
 * a {@link EntityState.hostId} naming the element it is cut into (an
 * `IfcOpeningElement` voiding an `IfcWall`, `IfcRelVoidsElement` in schema
 * terms). Three consequences, all of which can make an op FAIL or make two
 * node-disjoint ops diverge:
 *
 * 1. **Containment is an invariant, not a convention.** An opening must stay
 *    inside its host's bounds. An op that would move/resize a host so that a
 *    hosted opening escapes it, or that would move an opening out of its
 *    host, is REJECTED ({@link SpatialRejectionError}). Rejection reads state
 *    the op does not write -- the host reads its openings' geometry, an
 *    opening reads its host's -- so whether an op applies at all can depend
 *    on an edit to a completely different node.
 * 2. **`geometry-replace` on a host re-cuts its openings.** The host's stored
 *    mesh becomes `proposed base geometry` + a deterministic record of the
 *    voids actually subtracted (each hosted opening's bounds clipped to the
 *    host's, appended to the mesh's vertex list -- see
 *    {@link stripVoidMarkers}). The cut is therefore a function of BOTH the
 *    host's new geometry and the openings' geometry *at re-cut time*.
 * 3. **Cuts are lazy, exactly as in every BIM authoring kernel.** Moving,
 *    adding or removing an opening does NOT re-cut the host; the host's
 *    recorded cut goes stale until the host is next edited. So `move host`
 *    then `move opening` records `cut(host_new, opening_old)`, while
 *    `move opening` then `move host` records `cut(host_new, opening_new)`:
 *    two ops with disjoint `writtenNodes` that genuinely do not commute.
 *
 * The conflict predicate stays sound because a host and its openings always
 * overlap spatially by construction (an opening lies inside its host), so any
 * host-op/opening-op cross pair intersects and is refused a certificate. That
 * is the whole point: the SPATIAL half of the predicate is now the only thing
 * standing between the certificate and a real divergence.
 *
 * Wire format: nothing here changes node-hash-v0 serialization. Hosting lives
 * in the model state and in {@link canonicalStateBytes}; the cut is recorded
 * inside the existing `GeometryMeshPayload` vertex arrays, so the frozen
 * `geometry-mesh` encoding hashes it unchanged (a different cut is a
 * different mesh, which is correct). A v1 spec would model hosting as its own
 * `IfcRelVoidsElement` `relationship` node; that is a spec question, not a
 * change this module is allowed to make.
 */

import { ProvenanceDag, type AnyNodeSpec } from './dag-engine.js';
import type {
  ElementPayload,
  GeometryMeshPayload,
  LayerPayload,
  PropertySetPayload,
  PropertyValue,
  RelationshipPayload,
} from './node-hash.js';
import {
  aabbFromMesh,
  computeFootprint,
  unionAabb,
  type Aabb,
  type EditOp,
  type Footprint,
} from './footprint.js';

/* ------------------------------------------------------------------ */
/* Model state                                                          */
/* ------------------------------------------------------------------ */

export interface EntityState {
  /** Stable cross-revision identity (IFC GlobalId-like). */
  key: string;
  ifcType: string;
  /** Must be one of the model's `storeyIds`. */
  storeyId: string;
  /**
   * Hosted openings only: the ELEMENT node id of the host this entity is cut
   * into (`IfcRelVoidsElement`). Undefined for ordinary entities. A hosted
   * entity must stay inside its host's bounds -- see the module docstring's
   * "spatially coupled semantics". Hosts are never themselves hosted (no
   * nesting in v0).
   */
  hostId?: string;
  /** pset node id -> payload. */
  psets: Map<string, PropertySetPayload>;
  /** mesh node id -> payload. */
  meshes: Map<string, GeometryMeshPayload>;
}

export interface ModelState {
  /** Fixed storey vocabulary. Ops never add/remove storeys in this model
   *  (spatial-structure edits are outside the v0 op vocabulary, matching
   *  footprint.ts's own container-kind caveat). */
  storeyIds: readonly string[];
  /** entity (element) node id -> entity state. */
  entities: Map<string, EntityState>;
}

/** Everything needed to materialize a new entity -- the payload of an
 *  `entity-add` op. Node ids must be globally fresh (not present in the
 *  state the op is applied to). */
export interface EntityInit {
  entityNodeId: string;
  key: string;
  ifcType: string;
  storeyId: string;
  /** Add the new entity as an opening hosted in this existing element (see
   *  {@link EntityState.hostId}). The host must exist, must not itself be
   *  hosted, and the new entity's bounds must lie inside the host's -- an
   *  add that violates any of those is rejected. */
  hostId?: string;
  psets: readonly { psetNodeId: string; payload: PropertySetPayload }[];
  meshes: readonly { meshNodeId: string; payload: GeometryMeshPayload }[];
}

/* ------------------------------------------------------------------ */
/* Ops                                                                  */
/* ------------------------------------------------------------------ */

export type MergeOp =
  | { opId: string; type: 'entity-add'; entity: EntityInit; region?: Aabb }
  | { opId: string; type: 'entity-remove'; entityNodeId: string; region?: Aabb }
  | { opId: string; type: 'attr-set'; psetNodeId: string; property: string; value: PropertyValue }
  | { opId: string; type: 'geometry-replace'; meshNodeId: string; payload: GeometryMeshPayload; region?: Aabb };

/** Thrown when an op cannot be applied to the given state (missing target,
 *  duplicate id). During auto-merge of a predicate-approved pair this must
 *  never fire -- if it does, the merge was unsound and the battery counts it. */
export class OpApplicationError extends Error {
  readonly opId: string;
  constructor(opId: string, message: string) {
    super(`@ifc-lite/provenance: op "${opId}": ${message}`);
    this.name = 'OpApplicationError';
    this.opId = opId;
  }
}

/**
 * An op refused on SPATIAL grounds: it would have broken the host/opening
 * containment invariant. A subclass of {@link OpApplicationError} so every
 * existing caller (replay, `attemptBothOrders`, the battery) treats it as a
 * clean, typed "this op does not apply here" -- but distinguishable, because
 * a spatial rejection is the whole point of Bet B4.2: it is an op failing
 * because of state it does not write.
 */
export class SpatialRejectionError extends OpApplicationError {
  constructor(opId: string, message: string) {
    super(opId, message);
    this.name = 'SpatialRejectionError';
  }
}

/* ------------------------------------------------------------------ */
/* Hosting: containment, void re-cut                                     */
/* ------------------------------------------------------------------ */

/** Slack (metres) allowed on the host-containment test, so an opening that is
 *  exactly flush with a host face (the normal case for a window reveal) is
 *  contained rather than a floating-point coin flip. */
export const HOST_CONTAINMENT_TOLERANCE_M = 1e-9;

/** Floats of `positions`/`normals` that the mesh's own `indices` actually
 *  reference. Anything past this is a void marker appended by
 *  {@link recutHost} -- see {@link stripVoidMarkers}. */
function baseVertexFloatCount(mesh: GeometryMeshPayload): number {
  const indices = mesh.indices;
  let maxIndex = -1;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (v > maxIndex) maxIndex = v;
  }
  const floats = (maxIndex + 1) * 3;
  return Math.min(floats, mesh.positions.length);
}

/**
 * The uncut geometry of a (possibly re-cut) host mesh.
 *
 * A re-cut host records the voids it subtracted as extra, unindexed vertex
 * pairs appended to `positions`/`normals` (min corner, max corner of each
 * clipped void, in the mesh's local frame, ordered by opening node id). The
 * model does not tessellate the cut -- it records it -- which keeps the whole
 * thing inside the FROZEN `geometry-mesh` payload shape while still making a
 * different cut a different mesh hash. Everything past the last
 * index-referenced vertex is such a marker, so stripping is exact and
 * idempotent.
 */
export function stripVoidMarkers(mesh: GeometryMeshPayload): GeometryMeshPayload {
  const keep = baseVertexFloatCount(mesh);
  if (keep === mesh.positions.length) return mesh;
  return {
    ...mesh,
    positions: Array.from(mesh.positions).slice(0, keep),
    normals: Array.from(mesh.normals).slice(0, keep),
  };
}

/** World-space bounds of an entity's UNCUT geometry (void markers stripped),
 *  or undefined when the entity carries no geometry at all. */
function baseAabbOfEntity(entity: EntityState): Aabb | undefined {
  const boxes: Aabb[] = [];
  for (const mesh of entity.meshes.values()) boxes.push(aabbFromMesh(stripVoidMarkers(mesh)));
  return boxes.length > 0 ? unionAabb(boxes) : undefined;
}

function aabbContains(outer: Aabb, inner: Aabb, tolerance = HOST_CONTAINMENT_TOLERANCE_M): boolean {
  for (let i = 0; i < 3; i++) {
    if (inner.min[i] < outer.min[i] - tolerance) return false;
    if (inner.max[i] > outer.max[i] + tolerance) return false;
  }
  return true;
}

/** `box` clipped to `clip`; callers only use this when the two overlap (the
 *  containment invariant guarantees it), so no empty-box case arises. */
function clipAabb(box: Aabb, clip: Aabb): Aabb {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    min[i] = Math.max(box.min[i], clip.min[i]);
    max[i] = Math.min(box.max[i], clip.max[i]);
    if (max[i] < min[i]) max[i] = min[i];
  }
  return { min, max };
}

/** Every entity hosted in `hostEntityId`, sorted by node id (determinism:
 *  the re-cut record's order must not depend on Map insertion order). */
function hostedOpenings(state: ModelState, hostEntityId: string): [string, EntityState][] {
  const found: [string, EntityState][] = [];
  for (const [id, entity] of state.entities) {
    if (entity.hostId === hostEntityId) found.push([id, entity]);
  }
  found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return found;
}

/**
 * Re-cut a host: rewrite every one of its meshes as `uncut geometry` + the
 * void markers for `openings` (each opening's bounds clipped to the host's,
 * expressed in that mesh's local frame). Idempotent -- the previous cut is
 * stripped first -- and a pure function of (host geometry, opening geometry),
 * which is exactly why the ORDER in which a host edit and an opening edit are
 * applied is observable.
 */
function recutHost(host: EntityState, openings: readonly [string, EntityState][]): void {
  const stripped = new Map<string, GeometryMeshPayload>();
  for (const [id, mesh] of host.meshes) stripped.set(id, stripVoidMarkers(mesh));
  if (stripped.size === 0) return;
  const hostBox = unionAabb([...stripped.values()].map(aabbFromMesh));

  const markers: number[] = [];
  for (const [, opening] of openings) {
    const box = baseAabbOfEntity(opening);
    if (!box) continue;
    const cut = clipAabb(box, hostBox);
    markers.push(cut.min[0], cut.min[1], cut.min[2], cut.max[0], cut.max[1], cut.max[2]);
  }

  for (const [meshId, base] of stripped) {
    if (markers.length === 0) {
      host.meshes.set(meshId, base);
      continue;
    }
    const origin = base.origin;
    const local = markers.map((value, i) => value - origin[i % 3]);
    host.meshes.set(meshId, {
      ...base,
      positions: [...Array.from(base.positions), ...local],
      normals: [...Array.from(base.normals), ...local.map(() => 0)],
    });
  }
}

/** Throw unless every opening hosted in `hostEntityId` is inside the host's
 *  (uncut) bounds. The host's read set: an edit to ANY of these openings can
 *  flip this verdict, which is what makes host and opening edits fail to
 *  commute. */
function assertOpeningsContained(
  opId: string,
  hostEntityId: string,
  host: EntityState,
  openings: readonly [string, EntityState][],
): void {
  if (openings.length === 0) return;
  const hostBox = baseAabbOfEntity(host);
  if (!hostBox) {
    throw new SpatialRejectionError(opId, `host "${hostEntityId}" has no geometry but hosts ${openings.length} opening(s)`);
  }
  for (const [openingId, opening] of openings) {
    const box = baseAabbOfEntity(opening);
    if (!box) continue;
    if (!aabbContains(hostBox, box)) {
      throw new SpatialRejectionError(
        opId,
        `opening "${openingId}" would fall outside its host "${hostEntityId}" (hosted openings must stay inside the host)`,
      );
    }
  }
}

/** Throw unless `opening` is inside its host's (uncut) bounds. The opening's
 *  read set: an edit to the HOST can flip this verdict. */
function assertInsideHost(state: ModelState, opId: string, openingId: string, opening: EntityState): void {
  const hostId = opening.hostId;
  if (hostId === undefined) return;
  const host = state.entities.get(hostId);
  if (!host) {
    throw new SpatialRejectionError(opId, `opening "${openingId}" references host "${hostId}", which does not exist`);
  }
  const box = baseAabbOfEntity(opening);
  if (!box) return;
  const hostBox = baseAabbOfEntity(host);
  if (!hostBox) {
    throw new SpatialRejectionError(opId, `host "${hostId}" of opening "${openingId}" has no geometry`);
  }
  if (!aabbContains(hostBox, box)) {
    throw new SpatialRejectionError(
      opId,
      `opening "${openingId}" would fall outside its host "${hostId}" (hosted openings must stay inside the host)`,
    );
  }
}

function findPsetOwner(state: ModelState, psetNodeId: string): [string, EntityState] | undefined {
  for (const [id, entity] of state.entities) {
    if (entity.psets.has(psetNodeId)) return [id, entity];
  }
  return undefined;
}

function findMeshOwner(state: ModelState, meshNodeId: string): [string, EntityState] | undefined {
  for (const [id, entity] of state.entities) {
    if (entity.meshes.has(meshNodeId)) return [id, entity];
  }
  return undefined;
}

function cloneEntity(entity: EntityState): EntityState {
  const clone: EntityState = {
    key: entity.key,
    ifcType: entity.ifcType,
    storeyId: entity.storeyId,
    psets: new Map(entity.psets),
    meshes: new Map(entity.meshes),
  };
  if (entity.hostId !== undefined) clone.hostId = entity.hostId;
  return clone;
}

/** Shallow-clone the state (payloads are treated as immutable values -- every
 *  mutation below installs a NEW payload object, never edits one in place). */
export function cloneState(state: ModelState): ModelState {
  const entities = new Map<string, EntityState>();
  for (const [id, entity] of state.entities) entities.set(id, cloneEntity(entity));
  return { storeyIds: [...state.storeyIds], entities };
}

/** Apply one op, returning a NEW state (the input is never mutated). Throws
 *  {@link OpApplicationError} when the op does not apply. */
export function applyOp(state: ModelState, op: MergeOp): ModelState {
  const next = cloneState(state);
  switch (op.type) {
    case 'entity-add': {
      const init = op.entity;
      if (next.entities.has(init.entityNodeId)) {
        throw new OpApplicationError(op.opId, `entity-add target "${init.entityNodeId}" already exists`);
      }
      if (!next.storeyIds.includes(init.storeyId)) {
        throw new OpApplicationError(op.opId, `entity-add storey "${init.storeyId}" is not in the model`);
      }
      const entity: EntityState = {
        key: init.key,
        ifcType: init.ifcType,
        storeyId: init.storeyId,
        psets: new Map(init.psets.map((p) => [p.psetNodeId, p.payload])),
        meshes: new Map(init.meshes.map((m) => [m.meshNodeId, m.payload])),
      };
      if (init.hostId !== undefined) {
        const host = next.entities.get(init.hostId);
        if (!host) {
          throw new SpatialRejectionError(op.opId, `entity-add host "${init.hostId}" does not exist`);
        }
        if (host.hostId !== undefined) {
          throw new OpApplicationError(op.opId, `entity-add host "${init.hostId}" is itself hosted (no nesting in v0)`);
        }
        entity.hostId = init.hostId;
      }
      next.entities.set(init.entityNodeId, entity);
      // Containment is checked AFTER insertion so the opening sees the state
      // it will actually live in. Adding an opening deliberately does NOT
      // re-cut the host: voids are lazy (module docstring, point 3).
      assertInsideHost(next, op.opId, init.entityNodeId, entity);
      return next;
    }
    case 'entity-remove': {
      const target = next.entities.get(op.entityNodeId);
      if (!target) {
        throw new OpApplicationError(op.opId, `entity-remove target "${op.entityNodeId}" does not exist`);
      }
      next.entities.delete(op.entityNodeId);
      // Removing a host takes its openings with it -- an opening cannot
      // outlive the element it voids. Declared in the footprint (see
      // computeMergeOpFootprint), so this cascade is never a hidden write.
      for (const [openingId] of hostedOpenings(next, op.entityNodeId)) {
        next.entities.delete(openingId);
      }
      return next;
    }
    case 'attr-set': {
      const owner = findPsetOwner(next, op.psetNodeId);
      if (!owner) {
        throw new OpApplicationError(op.opId, `attr-set target pset "${op.psetNodeId}" does not exist`);
      }
      const [, entity] = owner;
      const old = entity.psets.get(op.psetNodeId) as PropertySetPayload;
      const properties = old.properties.filter((p) => p.name !== op.property);
      properties.push({ name: op.property, value: op.value });
      entity.psets.set(op.psetNodeId, { name: old.name, properties });
      return next;
    }
    case 'geometry-replace': {
      const owner = findMeshOwner(next, op.meshNodeId);
      if (!owner) {
        throw new OpApplicationError(op.opId, `geometry-replace target mesh "${op.meshNodeId}" does not exist`);
      }
      const [ownerId, entity] = owner;
      entity.meshes.set(op.meshNodeId, op.payload);
      // Moving/resizing a hosted opening: it must still fit its host.
      assertInsideHost(next, op.opId, ownerId, entity);
      // Moving/resizing a HOST: every opening it carries must still fit, and
      // the host is re-cut against the openings AS THEY ARE NOW. Both halves
      // read nodes this op does not write -- the coupling B4.2 exists to make
      // measurable.
      const openings = hostedOpenings(next, ownerId);
      if (openings.length > 0) {
        assertOpeningsContained(op.opId, ownerId, entity, openings);
        recutHost(entity, openings);
      }
      return next;
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`@ifc-lite/provenance: unknown op type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Apply a client's op set in order. */
export function applyOps(state: ModelState, ops: readonly MergeOp[]): ModelState {
  let current = state;
  for (const op of ops) current = applyOp(current, op);
  return current;
}

/* ------------------------------------------------------------------ */
/* Canonical bytes ("the deterministic kernel model")                    */
/* ------------------------------------------------------------------ */

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function canonicalMesh(payload: GeometryMeshPayload): unknown {
  return {
    expressId: payload.expressId,
    geometryClass: payload.geometryClass,
    positions: Array.from(payload.positions as ArrayLike<number>),
    normals: Array.from(payload.normals as ArrayLike<number>),
    indices: Array.from(payload.indices as ArrayLike<number>),
    origin: [...payload.origin],
  };
}

/**
 * Canonical serialization of the whole state: entities sorted by node id,
 * psets/meshes sorted by node id, properties sorted by name. Insertion order
 * never leaks into the output, so two replicas that hold the same logical
 * state produce byte-identical output regardless of the order edits arrived
 * in -- this string (UTF-8) IS the "model bytes" the M4 theorem quantifies
 * over in this prototype. (JSON.stringify normalizes -0 to "0", matching
 * node-hash.ts's own -0 normalization.)
 */
export function canonicalStateBytes(state: ModelState): string {
  const entityIds = [...state.entities.keys()].sort();
  const entities = entityIds.map((id) => {
    const entity = state.entities.get(id) as EntityState;
    const psetIds = [...entity.psets.keys()].sort();
    const meshIds = [...entity.meshes.keys()].sort();
    return {
      id,
      key: entity.key,
      ifcType: entity.ifcType,
      storeyId: entity.storeyId,
      // Hosting is part of the logical state (an opening cut into a different
      // wall is a different model), so the convergence oracle sees it.
      hostId: entity.hostId ?? null,
      psets: psetIds.map((pid) => {
        const p = entity.psets.get(pid) as PropertySetPayload;
        return { id: pid, name: p.name, properties: sortByName(p.properties) };
      }),
      meshes: meshIds.map((mid) => ({ id: mid, ...(canonicalMesh(entity.meshes.get(mid) as GeometryMeshPayload) as object) })),
    };
  });
  return JSON.stringify({ storeys: [...state.storeyIds], entities });
}

/* ------------------------------------------------------------------ */
/* DAG construction and Merkle root                                      */
/* ------------------------------------------------------------------ */

function storeyNodeId(storeyId: string): string {
  return `storey-rel:${storeyId}`;
}

export const MERGE_MODEL_ROOT_NODE_ID = 'root';

/**
 * Build the (unhashed) node-hash-v0 DAG for a state: mesh/pset leaves ->
 * element nodes -> one `relationship` node per storey -> one root `layer`
 * node. Same shape and kinds as g1/g2 and the fixed test fixture, so
 * footprint.ts's container-kind crux rule applies unchanged. Call
 * `await dag.build()` to hash it; structure-only uses (footprints) don't
 * need to.
 */
export function buildStateDag(state: ModelState): ProvenanceDag {
  const dag = new ProvenanceDag();
  const specs: AnyNodeSpec[] = [];
  const elementsByStorey = new Map<string, string[]>();
  for (const storeyId of state.storeyIds) elementsByStorey.set(storeyId, []);

  const entityIds = [...state.entities.keys()].sort();
  for (const entityId of entityIds) {
    const entity = state.entities.get(entityId) as EntityState;
    const byStorey = elementsByStorey.get(entity.storeyId);
    if (!byStorey) {
      throw new Error(`@ifc-lite/provenance: buildStateDag: entity "${entityId}" references unknown storey "${entity.storeyId}"`);
    }
    byStorey.push(entityId);

    const psetIds = [...entity.psets.keys()].sort();
    const meshIds = [...entity.meshes.keys()].sort();
    for (const pid of psetIds) {
      specs.push({ id: pid, kind: 'property-set', payload: entity.psets.get(pid) as PropertySetPayload });
    }
    for (const mid of meshIds) {
      specs.push({ id: mid, kind: 'geometry-mesh', payload: entity.meshes.get(mid) as GeometryMeshPayload });
    }
    const children = [...meshIds, ...psetIds];
    specs.push({
      id: entityId,
      kind: 'element',
      children,
      buildPayload: (h): ElementPayload => ({
        key: entity.key,
        ifcType: entity.ifcType,
        components: [
          ...meshIds.map((mid) => ({ componentKey: `geometry-mesh:${mid}`, hash: h.get(mid) as string })),
          ...psetIds.map((pid) => ({ componentKey: `pset:${pid}`, hash: h.get(pid) as string })),
        ],
      }),
    });
  }

  for (const storeyId of state.storeyIds) {
    const elementIds = elementsByStorey.get(storeyId) as string[];
    specs.push({
      id: storeyNodeId(storeyId),
      kind: 'relationship',
      children: elementIds,
      buildPayload: (h): RelationshipPayload => ({
        relType: 'IfcRelContainedInSpatialStructure',
        roles: [{ roleName: 'RelatedElements', refs: elementIds.map((id) => h.get(id) as string) }],
      }),
    });
  }

  const storeyNodeIds = state.storeyIds.map(storeyNodeId);
  specs.push({
    id: MERGE_MODEL_ROOT_NODE_ID,
    kind: 'layer',
    children: storeyNodeIds,
    buildPayload: (h): LayerPayload => ({
      layerId: 'blake3:merge-model-v0-root',
      childHashes: storeyNodeIds.map((id) => h.get(id) as string),
    }),
  });

  for (const spec of specs) dag.addNode(spec);
  return dag;
}

/** node-hash-v0 Merkle root of the state -- the commitment commutation
 *  certificates carry. Deterministic: same logical state, same root hash
 *  (child sets are sorted both here and inside the composite encodings). */
export async function hashModelState(state: ModelState): Promise<string> {
  const dag = buildStateDag(state);
  await dag.build();
  return dag.getHash(MERGE_MODEL_ROOT_NODE_ID) as string;
}

/* ------------------------------------------------------------------ */
/* Footprints                                                            */
/* ------------------------------------------------------------------ */

function regionOfMeshes(meshes: Iterable<GeometryMeshPayload>): Aabb | undefined {
  // No silent catch here: a mesh aabbFromMesh cannot box (e.g. zero
  // vertices) is a malformed input to THIS op model -- every mesh the
  // merge model authors carries geometry -- and swallowing the throw
  // would silently shrink an op's spatial footprint, weakening the very
  // conflict predicate the certificates rely on.
  const boxes: Aabb[] = [];
  for (const mesh of meshes) {
    boxes.push(aabbFromMesh(mesh));
  }
  return boxes.length > 0 ? unionAabb(boxes) : undefined;
}

/** Union `own` with the (uncut) bounds of `hostId`'s host, when the op's
 *  subject is a hosted opening -- the read set that the containment rule and
 *  the lazy re-cut make load-bearing (see {@link computeMergeOpFootprint}). */
function withHostRegion(state: ModelState, hostId: string | undefined, own: Aabb | undefined): Aabb | undefined {
  if (hostId === undefined) return own;
  const host = state.entities.get(hostId);
  if (!host) return own;
  const hostBox = baseAabbOfEntity(host);
  if (!hostBox) return own;
  return own ? unionAabb([own, hostBox]) : hostBox;
}

/**
 * Footprint of a {@link MergeOp} against a base state and its structure DAG
 * (`dag` must be `buildStateDag(state)` -- hashes not required).
 *
 * - `attr-set` / `geometry-replace` / `entity-remove` targets exist in the
 *   base DAG, so this delegates to footprint.ts's `computeFootprint`
 *   unchanged (the crux ancestor rule included). `geometry-replace` derives
 *   its region as OLD union NEW mesh bounds (the op touches both where the
 *   geometry was and where it goes); `entity-remove` uses the entity's mesh
 *   bounds.
 * - `entity-add` targets fresh ids the base DAG has never seen, so the
 *   footprint is built directly: writtenNodes = the op's own new node ids
 *   (entity + psets + meshes), region = union of the new meshes' bounds.
 *   Sound by construction: another op can only interact with the add by
 *   claiming one of those very ids (structural intersection) or by touching
 *   space the new geometry occupies (spatial intersection).
 *
 * Hosting (B4.2) adds two rules, both of which keep the predicate SOUND under
 * the coupled semantics:
 *
 * - `entity-add` of a hosted opening unions its HOST's current bounds into
 *   its region. Every other opening op is covered without widening, because
 *   the containment invariant puts the opening's CURRENT bounds inside its
 *   host, and every opening op's region already contains those (a move is
 *   old-union-new; a remove is the entity's own bounds) -- so it necessarily
 *   intersects any host op's region, which always covers the host's old box.
 *   An `entity-add` has no "old" bounds to lean on: its geometry is inside
 *   the host only if the add is valid, and an add that is invalid against the
 *   base is exactly the case where a missed conflict would be unsound. The
 *   host's box closes that hole and nothing else needs it.
 * - `entity-remove` of a HOST declares its hosted openings' element ids as
 *   additional targets, because applying it deletes them (the cascade in
 *   {@link applyOp}). A write is never left undeclared.
 *
 * Both rules assume the base state satisfies the containment invariant --
 * which {@link applyOp} enforces on every op that could break it.
 */
export function computeMergeOpFootprint(dag: ProvenanceDag, state: ModelState, op: MergeOp): Footprint {
  switch (op.type) {
    case 'entity-add': {
      const writtenNodes = new Set<string>([op.entity.entityNodeId]);
      for (const p of op.entity.psets) writtenNodes.add(p.psetNodeId);
      for (const m of op.entity.meshes) writtenNodes.add(m.meshNodeId);
      const own = regionOfMeshes(op.entity.meshes.map((m) => m.payload));
      const region = op.region ?? withHostRegion(state, op.entity.hostId, own);
      return { opId: op.opId, writtenNodes, region: region ?? null };
    }
    case 'entity-remove': {
      const entity = state.entities.get(op.entityNodeId);
      if (!entity) {
        throw new Error(`@ifc-lite/provenance: computeMergeOpFootprint: unknown entity "${op.entityNodeId}"`);
      }
      const openings = hostedOpenings(state, op.entityNodeId);
      const boxes: Aabb[] = [];
      const own = regionOfMeshes(entity.meshes.values());
      if (own) boxes.push(own);
      for (const [, opening] of openings) {
        const box = regionOfMeshes(opening.meshes.values());
        if (box) boxes.push(box);
      }
      const region = op.region ?? (boxes.length > 0 ? unionAabb(boxes) : undefined);
      const editOp: EditOp = {
        opId: op.opId,
        kind: 'geometry-edit',
        targetNodeIds: [op.entityNodeId, ...openings.map(([id]) => id)],
        region,
      };
      return computeFootprint(dag, editOp);
    }
    case 'attr-set': {
      const editOp: EditOp = { opId: op.opId, kind: 'property-edit', targetNodeIds: [op.psetNodeId] };
      return computeFootprint(dag, editOp);
    }
    case 'geometry-replace': {
      let region = op.region;
      if (!region) {
        const owner = findMeshOwner(state, op.meshNodeId);
        if (!owner) {
          throw new Error(`@ifc-lite/provenance: computeMergeOpFootprint: unknown mesh "${op.meshNodeId}"`);
        }
        region = regionOfMeshes([owner[1].meshes.get(op.meshNodeId) as GeometryMeshPayload, op.payload]);
      }
      const editOp: EditOp = { opId: op.opId, kind: 'geometry-edit', targetNodeIds: [op.meshNodeId], region };
      return computeFootprint(dag, editOp);
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`@ifc-lite/provenance: unknown op type: ${JSON.stringify(exhaustive)}`);
    }
  }
}
