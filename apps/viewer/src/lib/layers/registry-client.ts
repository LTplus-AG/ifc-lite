/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer-registry client (#1717 V3): a thin fetch wrapper over the
 * collab-server registry (`/api/v1/layers|refs|reviews`, 10-registry.md).
 * Derives its HTTP base from the collab websocket URL like the blob
 * store, and authenticates Bearer-only (the registry rejects `?token=`).
 *
 * Registry merges run SERVER-side (that is where ref policies and
 * approvals are enforced) — the client only ferries the candidate id,
 * preview flag, and per-conflict resolutions.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import type { MergeConflict, MergePlan, RefEntry } from '@ifc-lite/merge';
import { collabServerUrl } from '@/lib/collab/config';

export interface RegistryMergeOutcome {
  status: 'fast-forward' | 'merged' | 'preview' | 'conflicts' | 'policy-failure' | 'unrelated-base';
  layers?: string[];
  merge_layer?: string;
  plan?: MergePlan;
  conflicts?: MergeConflict[];
  reason?: string;
  /** Sent on unrelated-base outcomes instead of `reason`. */
  declared_base?: { kind: string; id: string };
  /** On previews/merges: whether the candidate's declared base was found on the ref. */
  ancestor_matched?: boolean;
}

export interface RegistryResolutionInput {
  path: string;
  component_key?: string;
  choice: 'ours' | 'theirs' | 'edited';
  /** Replacement component attributes; required when `choice === 'edited'`. */
  attributes?: Record<string, unknown>;
}

/** A review comment as a BCF topic bound to (review, entity, componentKey?). */
export interface RegistryReviewTopic {
  guid: string;
  title: string;
  description?: string;
  entity: string;
  componentKey?: string;
  author?: string;
  createdAt: string;
  viewpoint?: Record<string, unknown>;
}

export interface RegistryReviewSummary {
  id: string;
  layerId: string;
  into: string;
  reviewers: string[];
  status: 'open' | 'changes-requested' | 'approved';
  topics?: RegistryReviewTopic[];
  openedBy?: string;
  openedAt: string;
  approvedBy?: string;
}

export class RegistryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
  }
}

export class LayerRegistryClient {
  private readonly base: string;
  private readonly token?: string;

  constructor(baseUrl: string, token?: string) {
    this.base = `${baseUrl.replace(/\/$/, '')}/api/v1`;
    this.token = token;
  }

  /** Client bound to the configured collab server, or null when off. */
  static fromCollabConfig(token?: string): LayerRegistryClient | null {
    const ws = collabServerUrl();
    if (!ws) return null;
    return new LayerRegistryClient(ws.replace(/^ws/, 'http'), token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    // Merge outcomes ride non-2xx codes (409 conflicts, 403 policy) with
    // a structured body — surface those to the caller, not as errors.
    if (!res.ok && !(parsed && typeof parsed === 'object' && 'status' in (parsed as object))) {
      const message = (parsed as { error?: string })?.error ?? `registry request failed (${res.status})`;
      throw new RegistryError(res.status, message);
    }
    return parsed as T;
  }

  listLayers(): Promise<{ layers: string[] }> {
    return this.request('GET', '/layers');
  }

  pullLayer(id: string): Promise<IfcxFile> {
    return this.request('GET', `/layers/${encodeURIComponent(id)}`);
  }

  pushLayer(file: IfcxFile): Promise<{ id: string }> {
    return this.request('POST', '/layers', file);
  }

  listRefs(): Promise<{ refs: Record<string, RefEntry> }> {
    return this.request('GET', '/refs');
  }

  getRef(name: string): Promise<{ ref: string } & RefEntry> {
    return this.request('GET', `/refs/${encodeURIComponent(name)}`);
  }

  putRef(name: string, entry: { layers?: string[]; policy?: RefEntry['policy'] }): Promise<{ ref: string } & RefEntry> {
    return this.request('PUT', `/refs/${encodeURIComponent(name)}`, entry);
  }

  mergeRef(
    name: string,
    init: {
      candidate: string;
      preview?: boolean;
      resolutions?: RegistryResolutionInput[];
      waivers?: Array<{ spec: string; reason: string }>;
    },
  ): Promise<RegistryMergeOutcome> {
    return this.request('POST', `/refs/${encodeURIComponent(name)}/merge`, init);
  }

  // ----- reviews (PR objects) + BCF-bound comments (08-review.md §8.6) -----

  listReviews(): Promise<{ reviews: RegistryReviewSummary[] }> {
    return this.request('GET', '/reviews');
  }

  openReview(init: { layer_id: string; into: string; reviewers?: string[] }): Promise<{ id: string }> {
    return this.request('POST', '/reviews', init);
  }

  getReview(id: string): Promise<RegistryReviewSummary> {
    return this.request('GET', `/reviews/${encodeURIComponent(id)}`);
  }

  listTopics(reviewId: string): Promise<{ topics: RegistryReviewTopic[] }> {
    return this.request('GET', `/reviews/${encodeURIComponent(reviewId)}/topics`);
  }

  postTopic(
    reviewId: string,
    topic: {
      title: string;
      description?: string;
      entity: string;
      component_key?: string;
      viewpoint?: Record<string, unknown>;
    },
  ): Promise<{ guid: string }> {
    return this.request('POST', `/reviews/${encodeURIComponent(reviewId)}/topics`, topic);
  }

  /**
   * Fetch check-evidence bytes behind a manifest check's `report` /
   * `specDigest` (08-review.md §8.4). Evidence is raw text (IDS XML or
   * report JSON), not a JSON envelope — bypasses the JSON request path.
   * Null when the registry has no such report.
   */
  async getReport(digest: string): Promise<string | null> {
    const res = await fetch(`${this.base}/reports/${encodeURIComponent(digest)}`, {
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new RegistryError(res.status, `evidence fetch failed (${res.status})`);
    return res.text();
  }
}
