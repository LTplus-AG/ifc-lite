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
  readonly code: 'id-mismatch' | 'invalid-provenance';
  constructor(code: 'id-mismatch' | 'invalid-provenance', message: string) {
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

export class MemoryLayerRegistry implements LayerRegistryStore {
  private readonly layers = new Map<string, IfcxFile>();
  private readonly refs = new Map<string, RefEntry>();
  private readonly reviews = new Map<string, RegistryReview>();

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
    this.layers.set(computed, file);
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
    return file;
  }

  storeLayer(file: IfcxFile): string {
    // Merge layers arrive from the shared flow already content-addressed;
    // run them through the same integrity gate as external pushes.
    return this.push(file);
  }

  getRef(name: string): RefEntry | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, entry: RefEntry): void {
    this.refs.set(name, { layers: [...entry.layers], ...(entry.policy ? { policy: entry.policy } : {}) });
  }

  listRefs(): Record<string, RefEntry> {
    return Object.fromEntries(this.refs.entries());
  }

  getReview(id: string): RegistryReview | undefined {
    return this.reviews.get(id);
  }

  listReviews(): RegistryReview[] {
    return [...this.reviews.values()];
  }

  putReview(review: RegistryReview): void {
    this.reviews.set(review.id, review);
  }
}
