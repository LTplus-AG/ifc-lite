/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP / IFC2x3 / IFC4 source adapter: turn an `IfcDataStore` plus its meshes
 * into representation-agnostic `ClashElement`s, and precompute the
 * void/host/assembly pair exclusions from IFC relationships.
 *
 * This module is the only part of the package that depends on
 * `@ifc-lite/parser` / `@ifc-lite/query`; it is reached via the
 * `@ifc-lite/clash/step` subpath so the core stays version-neutral.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import type { MeshData } from '@ifc-lite/geometry';
import { makeExclusionSet, qualifiedKey } from '../exclude.js';
import { fromPositions } from '../math/aabb.js';
import type { ClashElement, ExclusionSet, Mat4 } from '../types.js';

/** Minimal federation contract — pass an `@ifc-lite/renderer` `FederationRegistry`. */
export interface FederationLike {
  toGlobalId(modelId: string, expressId: number): number;
}

/**
 * Types that are never physical clash candidates: spatial volumes, voids,
 * virtual/reference geometry, and non-product material associations. Including
 * them produced phantom clashes (IfcSpace, IfcVirtualElement, IfcOpeningElement,
 * even IfcMaterialConstituent) that no clash rule referenced - they are dropped
 * from the candidate set entirely, so "detect all" and per-rule runs only ever
 * consider real building elements. (#1464)
 */
const NON_CLASHABLE_TAGS: ReadonlySet<string> = new Set([
  'IfcSpace',
  'IfcSpatialZone',
  'IfcOpeningElement',
  'IfcOpeningStandardCase',
  'IfcVirtualElement',
  'IfcGrid',
  'IfcGridAxis',
  'IfcAnnotation',
  'IfcMaterial',
  'IfcMaterialConstituent',
  'IfcMaterialLayer',
]);

export interface StepAdapterOptions {
  store: IfcDataStore;
  meshes: MeshData[];
  /** Model/file id (federation). */
  modelId: string;
  /** When provided, `ref` is the federated globalId; otherwise the expressId. */
  federation?: FederationLike;
  /** Aligns this model into the common world frame (RTC + building rotation). */
  worldTransform?: Mat4;
  /** Precompute void/host/assembly exclusions. Default true. */
  buildExclusions?: boolean;
}

export interface StepAdapterResult {
  elements: ClashElement[];
  exclusions: ExclusionSet;
}

/**
 * Lift local-frame vertices into the model's world frame: `world = origin + local`
 * (the inverse of the renderer's per-element local frame). Returns a fresh f32
 * array; only called when `origin` is non-zero.
 */
function worldFramePositions(local: Float32Array, o: [number, number, number]): Float32Array {
  const out = new Float32Array(local.length);
  for (let i = 0; i + 2 < local.length; i += 3) {
    out[i] = local[i] + o[0];
    out[i + 1] = local[i + 1] + o[1];
    out[i + 2] = local[i + 2] + o[2];
  }
  return out;
}

export function elementsFromStep(options: StepAdapterOptions): StepAdapterResult {
  const { store, meshes, modelId, federation, worldTransform, buildExclusions = true } = options;

  const elements: ClashElement[] = [];
  const byExpressId = new Map<number, ClashElement>();

  for (const mesh of meshes) {
    if (!mesh.positions || mesh.positions.length === 0) continue;
    const expressId = mesh.expressId;
    const node = new EntityNode(store, expressId);

    // Drop non-physical / non-product geometry up front so it never becomes a
    // clash candidate (no rule should have to exclude IfcSpace by hand). (#1464)
    const tag = node.type || mesh.ifcType || 'IfcProduct';
    if (NON_CLASHABLE_TAGS.has(tag)) continue;

    // The wasm geometry path stores positions in the element's LOCAL frame
    // (world = origin + position; see `MeshData.origin`). Clash works in world
    // space — the `ClashElement` contract is world-frame triangles, and the
    // narrow phase is f32-quantized to stay byte-identical with the Rust kernel
    // — so fold the per-element origin into a world-frame positions array here.
    // No-op (shares the input buffer) when origin is absent/zero, e.g. the
    // native/server path or legacy meshing.
    const o = mesh.origin;
    const positions = o && (o[0] !== 0 || o[1] !== 0 || o[2] !== 0)
      ? worldFramePositions(mesh.positions, o)
      : mesh.positions;

    // Read stored (table-backed) values directly. `node.globalId` / `node.name`
    // fall back to `extractEntityAttributesOnDemand` when the table value is
    // empty (common: Name is optional, globalId is empty for fallback-only /
    // malformed roots) — and with a fresh node per mesh that fallback would fire
    // once per element inside this loop (AGENTS.md hot-loop ban). The table
    // getters never trigger on-demand extraction. `node.type` (getTypeName) and
    // `node.storey()` (relationship-only) are table-backed and stay.
    const storedGlobalId = store.entities.getGlobalId(expressId);
    const storedName = store.entities.getName(expressId);

    // Fall back to a model-scoped synthetic key rather than dropping geometry:
    // malformed IFC roots / fallback-only elements still participate in clashes.
    const key = storedGlobalId || `expressid:${expressId}`;

    const element: ClashElement = {
      key,
      ref: federation ? federation.toGlobalId(modelId, expressId) : expressId,
      model: modelId,
      tag,
      name: storedName || undefined,
      storey: node.storey()?.name || undefined,
      bounds: fromPositions(positions, worldTransform),
      positions,
      indices: mesh.indices,
      transform: worldTransform,
    };

    elements.push(element);
    byExpressId.set(expressId, element);
  }

  const exclusions = buildExclusions
    ? buildStepExclusions(store, byExpressId)
    : makeExclusionSet();

  return { elements, exclusions };
}

/**
 * Pair-exclusions from IFC relationships. Only relationship getters
 * (`voids`/`filledBy`/`decomposedBy`/`decomposes`) are used here; these read
 * the relationship graph and never call `extractEntityAttributesOnDemand`, so
 * the per-element loop stays off the AGENTS.md hot-loop anti-pattern:
 * - host vs the filler of its opening (wall vs door/window)
 * - element vs its own (meshed) opening
 * - members of the same `IfcRelAggregates` assembly
 */
export function buildStepExclusions(
  store: IfcDataStore,
  byExpressId: Map<number, ClashElement>,
): ExclusionSet {
  const pairs: Array<[string, string]> = [];

  for (const [expressId, element] of byExpressId) {
    const node = new EntityNode(store, expressId);
    const ek = qualifiedKey(element.model, element.key);

    for (const opening of node.voids()) {
      const openingElement = byExpressId.get(opening.expressId);
      if (openingElement) {
        pairs.push([ek, qualifiedKey(openingElement.model, openingElement.key)]);
      }
      for (const filler of opening.filledBy()) {
        const fillerElement = byExpressId.get(filler.expressId);
        if (fillerElement) {
          pairs.push([ek, qualifiedKey(fillerElement.model, fillerElement.key)]);
        }
      }
    }

    const parent = node.decomposedBy();
    if (parent) {
      for (const sibling of parent.decomposes()) {
        if (sibling.expressId === expressId) continue;
        const siblingElement = byExpressId.get(sibling.expressId);
        if (siblingElement) {
          pairs.push([ek, qualifiedKey(siblingElement.model, siblingElement.key)]);
        }
      }
    }
  }

  return makeExclusionSet(pairs);
}
