/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Local BCF draft batches (#6896, P11). A batch is reviewed coordination
 * intent: each topic keeps the exact clash findings it was drafted from, so
 * a later clash run can be reconciled member by member instead of being
 * re-assigned by title or similarity.
 */

import type { BCFViewpoint } from '@ifc-lite/bcf';
import type { ClashSeverity } from '@ifc-lite/clash';

export interface DraftElement {
  /** Durable element key (IFC GlobalId / prim path). */
  key: string;
  /** Viewer model id at draft time. */
  model: string;
  /** IFC type name. */
  tag: string;
  name?: string;
}

/** One clash finding, frozen when it was drafted. */
export interface DraftFinding {
  /** Model-independent identity: rule + both element keys (`clashReviewKey`). */
  reviewKey: string;
  /** Model-qualified identity distinguishing equal key pairs (`manualClashOccurrenceKey`). */
  occurrenceKey: string;
  rule: string;
  /** Detection class (`hard` / `clearance` / `touch`). */
  status: string;
  severity: ClashSeverity;
  distance: number;
  a: DraftElement;
  b: DraftElement;
  /** Render-frame overlap box, kept so a split or merge can frame its own viewpoint. */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

/** Where a topic's membership came from; reconciliation proposes new matches only for a group. */
export type DraftOrigin =
  | { kind: 'group'; workspaceId: string; groupId: string }
  | { kind: 'selection' }
  | { kind: 'archive' }
  /** A coordination review card (P18); `card` is the digest of the card's durable identity. */
  | { kind: 'review'; card: string };

export interface DraftComment {
  id: string;
  text: string;
}

export interface DraftTopic {
  /** Local BCF topic GUID: stable across edits, export and reimport. Servers assign their own. */
  guid: string;
  title: string;
  /** Human description only; the mapping footer is generated on export/publication. */
  description: string;
  topicType: string;
  topicStatus: string;
  priority?: string;
  labels: string[];
  /** Empty unless explicitly mapped to a server user from the project's `user_id_type` list. */
  assignedTo?: string;
  origin: DraftOrigin;
  members: DraftFinding[];
  /** Built through the clash BCF bridge; never carries snapshot bytes. */
  viewpoint?: BCFViewpoint;
  comments: DraftComment[];
}

/** The clash run, review snapshot (P18) or archive a batch was drafted from. Only clash batches reconcile against a newer run. */
export interface DraftSource {
  kind: 'clash' | 'archive' | 'review';
  /** Order-independent digest of the run's finding identities and rules. */
  runDigest: string;
  rules: string[];
  findingCount: number;
  capturedAt: string;
  /** Render frame -> IFC world offset used for every viewpoint in the batch. */
  worldOffset?: { x: number; y: number; z: number };
}

export interface DraftBatch {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  source: DraftSource;
  topics: DraftTopic[];
}

export const DRAFT_LIMITS = { topics: 500, members: 2_000, title: 200, description: 10_000, comment: 4_000, labels: 20 } as const;

/** A finding is claimed once per batch: by its occurrence, else by its durable review key. */
export function findingIdentity(finding: Pick<DraftFinding, 'reviewKey' | 'occurrenceKey'>): string {
  return finding.occurrenceKey || `review:${finding.reviewKey}`;
}
