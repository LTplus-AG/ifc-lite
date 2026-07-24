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
 */

import { ProvenanceDag, type NodeSpec } from './dag-engine.js';
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
  return {
    key: entity.key,
    ifcType: entity.ifcType,
    storeyId: entity.storeyId,
    psets: new Map(entity.psets),
    meshes: new Map(entity.meshes),
  };
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
      next.entities.set(init.entityNodeId, entity);
      return next;
    }
    case 'entity-remove': {
      if (!next.entities.delete(op.entityNodeId)) {
        throw new OpApplicationError(op.opId, `entity-remove target "${op.entityNodeId}" does not exist`);
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
      const [, entity] = owner;
      entity.meshes.set(op.meshNodeId, op.payload);
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
  const specs: NodeSpec[] = [];
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
  const boxes: Aabb[] = [];
  for (const mesh of meshes) {
    try {
      boxes.push(aabbFromMesh(mesh));
    } catch {
      // Degenerate mesh (no vertices): contributes no region.
    }
  }
  return boxes.length > 0 ? unionAabb(boxes) : undefined;
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
 */
export function computeMergeOpFootprint(dag: ProvenanceDag, state: ModelState, op: MergeOp): Footprint {
  switch (op.type) {
    case 'entity-add': {
      const writtenNodes = new Set<string>([op.entity.entityNodeId]);
      for (const p of op.entity.psets) writtenNodes.add(p.psetNodeId);
      for (const m of op.entity.meshes) writtenNodes.add(m.meshNodeId);
      const region = op.region ?? regionOfMeshes(op.entity.meshes.map((m) => m.payload));
      return { opId: op.opId, writtenNodes, region: region ?? null };
    }
    case 'entity-remove': {
      const entity = state.entities.get(op.entityNodeId);
      if (!entity) {
        throw new Error(`@ifc-lite/provenance: computeMergeOpFootprint: unknown entity "${op.entityNodeId}"`);
      }
      const region = op.region ?? regionOfMeshes(entity.meshes.values());
      const editOp: EditOp = { opId: op.opId, kind: 'geometry-edit', targetNodeIds: [op.entityNodeId], region };
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
