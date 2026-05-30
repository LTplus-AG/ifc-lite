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

export function elementsFromStep(options: StepAdapterOptions): StepAdapterResult {
  const { store, meshes, modelId, federation, worldTransform, buildExclusions = true } = options;

  const elements: ClashElement[] = [];
  const byExpressId = new Map<number, ClashElement>();

  for (const mesh of meshes) {
    if (!mesh.positions || mesh.positions.length === 0) continue;
    const expressId = mesh.expressId;
    const node = new EntityNode(store, expressId);

    // Fall back to a model-scoped synthetic key rather than dropping geometry:
    // malformed IFC roots / fallback-only elements still participate in clashes.
    const key = node.globalId || `expressid:${expressId}`;

    const element: ClashElement = {
      key,
      ref: federation ? federation.toGlobalId(modelId, expressId) : expressId,
      model: modelId,
      tag: node.type || mesh.ifcType || 'IfcProduct',
      name: node.name || undefined,
      storey: node.storey()?.name || undefined,
      bounds: fromPositions(mesh.positions, worldTransform),
      positions: mesh.positions,
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
 * Pair-exclusions from IFC relationships, using cached `EntityNode` getters
 * (never `extractEntityAttributesOnDemand` in a loop, per AGENTS.md):
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
