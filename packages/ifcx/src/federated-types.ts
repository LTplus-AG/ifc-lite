/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for federated composition (`federated-composition.ts`), kept apart
 * so the composer stays within its module-size budget.
 */

import type { ComposedNode } from './types.js';
import type { PathIndex } from './path-resolver.js';
import type { AttributeOpinions } from './opinions.js';


/**
 * Options for federated composition.
 */
export interface ComposeOptions {
  /** Progress callback */
  onProgress?: (phase: string, percent: number) => void;
  /** Maximum inheritance depth (default: 10) */
  maxInheritDepth?: number;
  /**
   * Keep every layer's own value per attribute on each composed node
   * (`ComposedNodeWithSources.opinions`), not only the winner. Off by
   * default so ordinary composition pays nothing. See `opinions.ts`.
   */
  retainOpinions?: boolean;
}

/**
 * Pre-composed node before inheritance resolution.
 */
export interface PreComposedNode {
  path: string;
  children: Record<string, string | null>;
  inherits: Record<string, string | null>;
  attributes: Record<string, unknown>;
  /** Track which layer contributed each attribute */
  attributeSources: Map<string, string>;
  /** Layers that define this path */
  definedInLayers: Set<string>;
  /** Every layer's own attribute values (only with `retainOpinions`) */
  opinions?: AttributeOpinions;
}

/**
 * Extended ComposedNode with source tracking.
 */
export interface ComposedNodeWithSources extends ComposedNode {
  /** Track which layer contributed each attribute */
  attributeSources: Map<string, { layerId: string; layerName: string }>;
  /** All layers that contributed to this node */
  contributingLayers: Set<string>;
  /**
   * Every layer's own value per attribute key, weakest first, strongest
   * last. Present only when composed with `retainOpinions`.
   */
  opinions?: AttributeOpinions;
}

/**
 * Result of federated composition.
 */
export interface FederatedCompositionResult {
  /** Composed nodes by path */
  composed: Map<string, ComposedNodeWithSources>;
  /** Path index for lookups */
  pathIndex: PathIndex;
  /** Root nodes (no parent) */
  roots: ComposedNodeWithSources[];
  /** Statistics */
  stats: {
    totalNodes: number;
    layersUsed: number;
    inheritanceResolutions: number;
    crossLayerReferences: number;
  };
}
