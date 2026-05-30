/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX / USD source adapter: turn a parsed IFCX (IFC5) file into
 * representation-agnostic `ClashElement`s, proving the clash core is
 * representation-agnostic (it runs equally on STEP and on USD/IFCX).
 *
 * Unlike the STEP adapter, IFCX geometry is pre-tessellated: `parseIfcx`
 * already returns world-space, Y-up triangle `meshes` (see ifcx's
 * `geometry-extractor`), so this adapter does no geometry math of its own.
 *
 * Identity mapping:
 * - `key`   = the USD prim PATH (the durable identity in IFCX; the parser
 *             stores it as the entity GlobalId and exposes it via `idToPath`).
 * - `ref`   = a deterministic, non-negative 31-bit FNV-1a hash of the prim
 *             path. We hash the PATH (not the synthetic auto-incrementing
 *             expressId) so the runtime ref is stable across re-parses and
 *             across federated layer reorderings, which is the whole point of
 *             a durable id. Collisions are astronomically unlikely for the
 *             path counts in a model and never affect correctness (clash
 *             identity is derived from `key`, not `ref`).
 * - `model` = `options.modelId`.
 * - `tag`   = the IFC class code when present (USD `bsi::ifc::class`),
 *             otherwise `'IfcProduct'`.
 *
 * Exclusions are derived purely from the file's own composition hierarchy
 * (parent/child `ContainsElements` + `Aggregates` edges that `parseIfcx`
 * builds from the USD `children` structure). This is the IFCX analogue of the
 * STEP void/host/assembly exclusions; it fabricates no relationships.
 *
 * This module is reached via the `@ifc-lite/clash/ifcx` subpath so the core
 * stays representation- and parser-neutral.
 */

import { parseIfcx, type MeshData } from '@ifc-lite/ifcx';
import { makeExclusionSet, qualifiedKey } from '../exclude.js';
import { fromPositions } from '../math/aabb.js';
import type { ClashElement, ExclusionSet } from '../types.js';

/**
 * Minimal structural view of `@ifc-lite/data`'s `RelationshipGraph`. We type it
 * locally (rather than importing `@ifc-lite/data`, which is not a direct
 * dependency of this package) and only touch the two directional halves. The
 * IFCX parser emits exclusively parent->child composition edges
 * (`ContainsElements` + `Aggregates`), so reading every edge — with no type
 * filter — is precisely the set of composition parent/child links.
 */
interface CompositionEdges {
  getTargets(entityId: number): number[];
}
interface CompositionGraph {
  forward: CompositionEdges;
  inverse: CompositionEdges;
}

export interface IfcxAdapterOptions {
  /** Raw IFCX (IFC5 JSON) bytes. */
  buffer: ArrayBuffer;
  /** Model/file id (federation). */
  modelId: string;
  /** Precompute parent/child composition exclusions. Default true. */
  buildExclusions?: boolean;
}

export interface IfcxAdapterResult {
  elements: ClashElement[];
  exclusions: ExclusionSet;
}

/**
 * Parse an IFCX buffer and project its pre-tessellated meshes into
 * `ClashElement`s. Async because `parseIfcx` is async.
 */
export async function elementsFromIfcx(options: IfcxAdapterOptions): Promise<IfcxAdapterResult> {
  const { buffer, modelId, buildExclusions = true } = options;

  const parsed = await parseIfcx(buffer);
  const { meshes, idToPath, entities, relationships } = parsed;

  // The IFCX geometry extractor associates each `UsdMesh` with the nearest
  // ancestor entity that has an expressId, so a single entity (one durable
  // prim path) can yield several `MeshData` (e.g. separate `Body`/`Axis`
  // representations or multiple sub-meshes). Group those meshes by their
  // owning entity first, then concatenate each group into one geometry, so a
  // given durable key produces exactly ONE `ClashElement` over all of it
  // rather than several aliasing elements that share a key/ref.
  const groups = new Map<number, MeshData[]>();
  for (const mesh of meshes) {
    if (!mesh.positions || mesh.positions.length === 0) continue;
    if (!mesh.indices || mesh.indices.length === 0) continue;

    const expressId = mesh.expressId;
    // The prim path is the durable USD identity; skip meshes we cannot key.
    if (!idToPath.has(expressId)) continue;

    const group = groups.get(expressId);
    if (group) {
      group.push(mesh);
    } else {
      groups.set(expressId, [mesh]);
    }
  }

  const elements: ClashElement[] = [];
  const byExpressId = new Map<number, ClashElement>();

  for (const [expressId, group] of groups) {
    // The prim path is the durable USD identity; skip entities we cannot key.
    // (It was present at grouping time; re-check to narrow without a cast.)
    const key = idToPath.get(expressId);
    if (!key) continue;
    const merged = mergeMeshes(group);

    const element: ClashElement = {
      key,
      ref: refFromPath(key),
      model: modelId,
      tag: resolveTag(group[0], entities, expressId),
      name: resolveName(entities, expressId),
      bounds: fromPositions(merged.positions),
      positions: merged.positions,
      indices: merged.indices,
    };

    elements.push(element);
    byExpressId.set(expressId, element);
  }

  const exclusions = buildExclusions
    ? buildIfcxExclusions(relationships, byExpressId)
    : makeExclusionSet();

  return { elements, exclusions };
}

/**
 * Pair-exclusions from the IFCX composition hierarchy. For every meshed
 * entity we exclude its composition parents and children (the
 * `ContainsElements` spatial-containment and `Aggregates` decomposition edges
 * the parser derives from USD `children`). These are exactly the
 * host/assembly relationships the STEP adapter excludes, expressed in IFCX
 * terms; no relationship is invented.
 */
export function buildIfcxExclusions(
  relationships: CompositionGraph,
  byExpressId: Map<number, ClashElement>,
): ExclusionSet {
  const pairs: Array<[string, string]> = [];

  for (const [expressId, element] of byExpressId) {
    // Children (this entity contains/aggregates them) and parents (inverse).
    // All IFCX edges are composition edges, so no type filter is needed.
    const ek = qualifiedKey(element.model, element.key);
    const children = relationships.forward.getTargets(expressId);
    const parents = relationships.inverse.getTargets(expressId);
    for (const relatedId of children) {
      const related = byExpressId.get(relatedId);
      if (related) pairs.push([ek, qualifiedKey(related.model, related.key)]);
    }
    for (const relatedId of parents) {
      const related = byExpressId.get(relatedId);
      if (related) pairs.push([ek, qualifiedKey(related.model, related.key)]);
    }
  }

  return makeExclusionSet(pairs);
}

/**
 * IFC class for the element's `tag`. The IFCX geometry extractor stores the
 * `bsi::ifc::class.code` on `mesh.ifcType`; we fall back to the entity table's
 * resolved type name, then to a neutral `IfcProduct`.
 */
function resolveTag(
  mesh: MeshData,
  entities: { getTypeName(id: number): string },
  expressId: number,
): string {
  if (mesh.ifcType && mesh.ifcType.length > 0) return mesh.ifcType;
  const typeName = entities.getTypeName(expressId);
  if (typeName && typeName.length > 0 && typeName !== 'Unknown') return typeName;
  return 'IfcProduct';
}

function resolveName(
  entities: { getName(id: number): string },
  expressId: number,
): string | undefined {
  const name = entities.getName(expressId);
  return name && name.length > 0 ? name : undefined;
}

/**
 * Concatenate a group of meshes (all belonging to the same entity) into a
 * single position/index buffer. Each subsequent mesh's indices are offset by
 * the running vertex count so the merged index buffer addresses the combined
 * vertex array. A single mesh is returned as-is (no copy) for the common case.
 */
function mergeMeshes(group: MeshData[]): { positions: Float32Array; indices: Uint32Array } {
  if (group.length === 1) {
    return { positions: group[0].positions, indices: group[0].indices };
  }

  let totalPositions = 0;
  let totalIndices = 0;
  for (const mesh of group) {
    totalPositions += mesh.positions.length;
    totalIndices += mesh.indices.length;
  }

  const positions = new Float32Array(totalPositions);
  const indices = new Uint32Array(totalIndices);
  let positionOffset = 0;
  let indexOffset = 0;
  let vertexBase = 0;
  for (const mesh of group) {
    positions.set(mesh.positions, positionOffset);
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexOffset + i] = mesh.indices[i] + vertexBase;
    }
    positionOffset += mesh.positions.length;
    indexOffset += mesh.indices.length;
    // 3 floats per vertex; the next mesh's indices start after these vertices.
    vertexBase += mesh.positions.length / 3;
  }

  return { positions, indices };
}

/**
 * Deterministic non-negative 31-bit ref derived purely from the prim path via
 * FNV-1a over the UTF-16 code units. No clock, no randomness: the same path
 * always yields the same ref.
 */
function refFromPath(path: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i) & 0xff;
    // 32-bit FNV prime multiply via shifts, kept in unsigned 32-bit space.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    // Mix the high byte of multi-byte code units so non-ASCII paths differ.
    const high = (path.charCodeAt(i) >> 8) & 0xff;
    if (high !== 0) {
      hash ^= high;
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
  }
  // Mask to 31 bits so the result is always a non-negative safe integer.
  return hash & 0x7fffffff;
}
