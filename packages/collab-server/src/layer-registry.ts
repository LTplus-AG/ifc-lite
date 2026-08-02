/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer registry store (10-registry.md): content-addressed layers, a ref
 * database with merge policies, and review (PR) objects. Implements the
 * `LayerRefStore` surface from `@ifc-lite/merge`, so the registry's merge
 * endpoint runs the exact flow the CLI runs locally.
 *
 * Two stores implement the interface: `MemoryLayerRegistry` (below;
 * dev/tests) and `FsLayerRegistry` (`layer-registry-fs.ts`; durable, for
 * deployments with a mounted volume). The storage trait is deliberately
 * dumb: push/pull by id, smart client.
 */

import { blake3Digest, computeLayerId, validateProvenance, getProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import type { LayerRefStore, RefEntry } from '@ifc-lite/merge';

export interface RegistryReviewDecision {
  entity: string;
  componentKey?: string;
  decision: 'accept' | 'reject';
  comment?: string;
}

export type RegistryReviewStatus = 'open' | 'changes-requested' | 'approved';

/**
 * A review comment as a standard BCF topic bound to (review, entity,
 * componentKey?) per 08-review.md §8.6 — exportable as plain BCF for
 * foreign tools, readable structurally by agents via `get_review_feedback`.
 * `entity` is the composition path (the IFC GUID); layer data is
 * path-keyed, never expressId-keyed.
 */
export interface RegistryReviewTopic {
  /** Server-minted BCF topic GUID. */
  guid: string;
  title: string;
  description?: string;
  entity: string;
  componentKey?: string;
  /** Authenticated author — server-derived, never caller-asserted. */
  author?: string;
  createdAt: string;
  /** Optional BCF viewpoint payload (camera, snapshot) captured client-side. */
  viewpoint?: Record<string, unknown>;
}

export interface RegistryReview {
  id: string;
  layerId: string;
  into: string;
  reviewers: string[];
  status: RegistryReviewStatus;
  feedback: RegistryReviewDecision[];
  /** BCF-shaped review comments; absent on records predating topics. */
  topics?: RegistryReviewTopic[];
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
  /**
   * Check-evidence blobs (08-review.md §8.4): the IDS spec + report files
   * whose blake3 digests a provenance manifest's `checks` entries carry
   * (`specDigest` / `report`). Content-addressed and verified on write.
   * Optional so caller-supplied stores predating evidence keep working —
   * the route answers 501 when the store lacks them.
   */
  putReport?(digest: string, bytes: Uint8Array): string;
  getReport?(digest: string): Uint8Array | undefined;
}

export interface MemoryLayerRegistryLimits {
  /** Max stored layers (default 10 000). Layers are immutable and never evicted. */
  maxLayers?: number;
  /** Max named refs (default 1 000). */
  maxRefs?: number;
  /** Max review objects (default 10 000). */
  maxReviews?: number;
  /** Max check-evidence blobs (default 10 000). */
  maxReports?: number;
}

/** The only content-address shape `computeLayerId`/`blake3Digest` emit. */
export const CONTENT_DIGEST_REGEX = /^blake3:[0-9a-f]{64}$/;

/**
 * Verify evidence bytes against their claimed digest. Evidence is text
 * (IDS XML, report JSON); `blake3Digest` NFC-normalizes strings, so accept
 * either the raw-bytes digest or the normalized-text digest — the CLI
 * hashes the decoded string at publish time.
 */
export function assertReportDigest(digest: string, bytes: Uint8Array): void {
  if (!CONTENT_DIGEST_REGEX.test(digest)) {
    throw new LayerPushError('id-mismatch', `unsupported content-address shape ${digest}`);
  }
  if (blake3Digest(bytes) === digest) return;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (blake3Digest(text) === digest) return;
  throw new LayerPushError('id-mismatch', `evidence bytes do not hash to the claimed digest ${digest}`);
}

/**
 * Integrity gate shared by every store implementation: verify that the
 * declared header id matches the canonical content address and, when a
 * provenance manifest is present, that it validates. Returns the id.
 * First-write-wins byte-identity is checked per store (each compares
 * against its own persisted representation).
 */
export function assertPushableLayer(file: IfcxFile): string {
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
  return computed;
}

export class MemoryLayerRegistry implements LayerRegistryStore {
  private readonly layers = new Map<string, IfcxFile>();
  private readonly refs = new Map<string, RefEntry>();
  private readonly reviews = new Map<string, RegistryReview>();
  private readonly reports = new Map<string, Uint8Array>();
  private readonly maxLayers: number;
  private readonly maxRefs: number;
  private readonly maxReviews: number;
  private readonly maxReports: number;

  // Immutable layers plus no eviction means an unbounded writer is a
  // memory-exhaustion vector; the caps turn that into a clean 507 at the
  // route instead of an OOM kill.
  constructor(limits: MemoryLayerRegistryLimits = {}) {
    this.maxLayers = limits.maxLayers ?? 10_000;
    this.maxRefs = limits.maxRefs ?? 1_000;
    this.maxReviews = limits.maxReviews ?? 10_000;
    this.maxReports = limits.maxReports ?? 10_000;
  }

  // The registry owns its state: objects are cloned on ingress and egress
  // so callers cannot mutate content-addressed layers, refs, or reviews
  // out-of-band — every change goes back through the integrity and policy
  // gates.

  push(file: IfcxFile): string {
    const computed = assertPushableLayer(file);
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

  putReport(digest: string, bytes: Uint8Array): string {
    assertReportDigest(digest, bytes);
    // Content-addressed and digest-verified, so a re-put is idempotent by
    // construction; keep the first write.
    if (this.reports.has(digest)) return digest;
    if (this.reports.size >= this.maxReports) {
      throw new LayerPushError('registry-full', `registry holds ${this.reports.size} reports (cap ${this.maxReports})`);
    }
    this.reports.set(digest, new Uint8Array(bytes));
    return digest;
  }

  getReport(digest: string): Uint8Array | undefined {
    const bytes = this.reports.get(digest);
    return bytes === undefined ? undefined : new Uint8Array(bytes);
  }
}
