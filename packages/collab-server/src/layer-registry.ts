/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer registry store (10-registry.md): content-addressed layers, a ref
 * database with merge policies, and review (PR) objects. Implements the
 * `LayerRefStore` surface from `@ifc-lite/merge`, so the registry's merge
 * endpoint runs the exact flow the CLI runs locally.
 *
 * v1 ships the in-memory store — the protocol, integrity gate, and
 * server-side policy enforcement are the deliverable; durable backends
 * implement the same interface (the storage trait is deliberately dumb:
 * push/pull by id, smart client).
 */

import { computeLayerId, validateProvenance, getProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import type { LayerRefStore, RefEntry } from '@ifc-lite/merge';

export interface RegistryReviewDecision {
  entity: string;
  componentKey?: string;
  decision: 'accept' | 'reject';
  comment?: string;
}

export type RegistryReviewStatus = 'open' | 'changes-requested' | 'approved';

export interface RegistryReview {
  id: string;
  layerId: string;
  into: string;
  reviewers: string[];
  status: RegistryReviewStatus;
  feedback: RegistryReviewDecision[];
  openedBy?: string;
  openedAt: string;
  /**
   * Authenticated principal that set status to `approved` — recorded by
   * the feedback endpoint, never caller-asserted. The merge endpoint
   * derives `requireHumanApproval` satisfaction from this field.
   */
  approvedBy?: string;
}

/** Thrown by `push` when content fails the integrity or provenance gate. */
export class LayerPushError extends Error {
  readonly code: 'id-mismatch' | 'invalid-provenance' | 'content-conflict' | 'registry-full';
  constructor(
    code: 'id-mismatch' | 'invalid-provenance' | 'content-conflict' | 'registry-full',
    message: string
  ) {
    super(message);
    this.name = 'LayerPushError';
    this.code = code;
  }
}

export interface LayerRegistryStore extends LayerRefStore {
  /** Verify the content address (and manifest when present), then store. */
  push(file: IfcxFile): string;
  hasLayer(layerId: string): boolean;
  listLayers(): string[];
  listRefs(): Record<string, RefEntry>;
  getReview(id: string): RegistryReview | undefined;
  listReviews(): RegistryReview[];
  putReview(review: RegistryReview): void;
}

export interface MemoryLayerRegistryLimits {
  /** Max stored layers (default 10 000). Layers are immutable and never evicted. */
  maxLayers?: number;
  /** Max named refs (default 1 000). */
  maxRefs?: number;
  /** Max review objects (default 10 000). */
  maxReviews?: number;
}

export class MemoryLayerRegistry implements LayerRegistryStore {
  private readonly layers = new Map<string, IfcxFile>();
  private readonly refs = new Map<string, RefEntry>();
  private readonly reviews = new Map<string, RegistryReview>();
  private readonly maxLayers: number;
  private readonly maxRefs: number;
  private readonly maxReviews: number;

  // Immutable layers plus no eviction means an unbounded writer is a
  // memory-exhaustion vector; the caps turn that into a clean 507 at the
  // route instead of an OOM kill.
  constructor(limits: MemoryLayerRegistryLimits = {}) {
    this.maxLayers = limits.maxLayers ?? 10_000;
    this.maxRefs = limits.maxRefs ?? 1_000;
    this.maxReviews = limits.maxReviews ?? 10_000;
  }

  // The registry owns its state: objects are cloned on ingress and egress
  // so callers cannot mutate content-addressed layers, refs, or reviews
  // out-of-band — every change goes back through the integrity and policy
  // gates.

  push(file: IfcxFile): string {
    const computed = computeLayerId(file);
    if (file.header.id !== computed) {
      throw new LayerPushError(
        'id-mismatch',
        `header.id ${file.header.id} does not match the canonical content address ${computed}`
      );
    }
    const manifest = getProvenance(file);
    if (manifest !== undefined) {
      const errors = validateProvenance(manifest);
      if (errors.length > 0) {
        throw new LayerPushError(
          'invalid-provenance',
          `provenance manifest invalid: ${errors.join('; ')}`
        );
      }
    }
    // Content addresses hash only the canonical bytes — signatures and
    // ifclite::derived content are deliberately excluded. First write wins:
    // a re-push of the same id must be byte-identical, otherwise an
    // attacker could swap the non-canonical parts (strip/forge signatures,
    // poison a derived cache) under an already-trusted id.
    const existing = this.layers.get(computed);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(file)) {
        throw new LayerPushError(
          'content-conflict',
          `layer ${computed} already exists with different non-canonical bytes; refusing overwrite`
        );
      }
      return computed;
    }
    if (this.layers.size >= this.maxLayers) {
      throw new LayerPushError('registry-full', `registry holds ${this.layers.size} layers (cap ${this.maxLayers})`);
    }
    this.layers.set(computed, structuredClone(file));
    return computed;
  }

  hasLayer(layerId: string): boolean {
    return this.layers.has(layerId);
  }

  listLayers(): string[] {
    return [...this.layers.keys()];
  }

  // LayerRefStore — consumed by the shared merge flow.
  loadLayer(layerId: string): IfcxFile {
    const file = this.layers.get(layerId);
    if (!file) throw new Error(`No layer ${layerId} in registry`);
    return structuredClone(file);
  }

  storeLayer(file: IfcxFile): string {
    // Merge layers arrive from the shared flow already content-addressed;
    // run them through the same integrity gate as external pushes.
    return this.push(file);
  }

  getRef(name: string): RefEntry | undefined {
    const entry = this.refs.get(name);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  setRef(name: string, entry: RefEntry): void {
    if (!this.refs.has(name) && this.refs.size >= this.maxRefs) {
      throw new LayerPushError('registry-full', `registry holds ${this.refs.size} refs (cap ${this.maxRefs})`);
    }
    this.refs.set(
      name,
      structuredClone({ layers: entry.layers, ...(entry.policy ? { policy: entry.policy } : {}) })
    );
  }

  listRefs(): Record<string, RefEntry> {
    return Object.fromEntries(
      [...this.refs.entries()].map(([name, entry]) => [name, structuredClone(entry)])
    );
  }

  getReview(id: string): RegistryReview | undefined {
    const review = this.reviews.get(id);
    return review === undefined ? undefined : structuredClone(review);
  }

  listReviews(): RegistryReview[] {
    return [...this.reviews.values()].map((review) => structuredClone(review));
  }

  putReview(review: RegistryReview): void {
    if (!this.reviews.has(review.id) && this.reviews.size >= this.maxReviews) {
      throw new LayerPushError('registry-full', `registry holds ${this.reviews.size} reviews (cap ${this.maxReviews})`);
    }
    this.reviews.set(review.id, structuredClone(review));
  }
}
