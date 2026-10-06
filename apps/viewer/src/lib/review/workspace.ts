/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Durable review decisions (P18, #6922): the human status and comment per
 * coordination card identity, stored as the native content kind
 * `reviewWorkspaces` (CAS saves, backup, import and recovery like every other
 * library). Only a person's explicit choice writes here; native statuses,
 * derived card states and assistant output are never stored as a decision.
 */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library';
import type { ContentDefinition } from '../storage/content-migration';

export const HUMAN_STATUSES = ['open', 'in-progress', 'resolved', 'accepted', 'dismissed'] as const;
export type HumanStatus = typeof HUMAN_STATUSES[number];

export interface CardDecision {
  cardKey: string;
  status: HumanStatus;
  comment: string;
  updatedAt: string;
}

export interface ReviewWorkspace { version: 1; id: string; name: string; decisions: CardDecision[] }

export const DEFAULT_REVIEW_WORKSPACE = 'coordination-review';
export const REVIEW_LIMITS = { decisions: 5_000, cardKey: 20_000, comment: 4_000 } as const;

const text = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);

function decodeDecision(value: unknown): CardDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!text(raw.cardKey, REVIEW_LIMITS.cardKey) || !HUMAN_STATUSES.includes(raw.status as HumanStatus)
    || !text(raw.comment, REVIEW_LIMITS.comment, true) || !text(raw.updatedAt, 40) || !Number.isFinite(Date.parse(raw.updatedAt))) return null;
  return { cardKey: raw.cardKey, status: raw.status as HumanStatus, comment: raw.comment, updatedAt: raw.updatedAt };
}

/** Strict: an invalid or duplicated decision refuses the whole workspace instead of dropping a review. */
export function decodeReviewWorkspace(value: unknown): ReviewWorkspace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !text(raw.id, 200) || !text(raw.name, 200) || !Array.isArray(raw.decisions)
    || raw.decisions.length > REVIEW_LIMITS.decisions) return null;
  const decisions = raw.decisions.map(decodeDecision);
  const keys = new Set<string>();
  for (const decision of decisions) {
    if (!decision || keys.has(decision.cardKey)) return null;
    keys.add(decision.cardKey);
  }
  return { version: 1, id: raw.id, name: raw.name, decisions: decisions.flatMap(decision => decision ? [decision] : []) };
}

/** Never written by an older viewer; the migration finds nothing and only records its marker. */
export const reviewWorkspacesContent: ContentDefinition<ReviewWorkspace> = {
  kind: 'reviewWorkspaces', legacyKey: 'ifc-lite-review-workspaces', decode: decodeReviewWorkspace,
};

export const useReviewWorkspaces = create<{ entries: ReviewWorkspace[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const reviewWorkspaceLibrary = createContentLibrary(reviewWorkspacesContent,
  () => useReviewWorkspaces.getState().entries,
  (entries, status) => useReviewWorkspaces.setState({ entries, status }));

/**
 * The review a person sees. An import never overwrites: a backup whose
 * decisions differ from the local review is stored under a fresh id, so those
 * copies are folded in here (per card, the newer decision wins) instead of
 * being orphaned under an id nothing reads.
 */
export function currentReviewWorkspace(entries: readonly ReviewWorkspace[]): ReviewWorkspace {
  const local = entries.find(entry => entry.id === DEFAULT_REVIEW_WORKSPACE)
    ?? { version: 1, id: DEFAULT_REVIEW_WORKSPACE, name: 'Coordination review', decisions: [] };
  const imported = entries.filter(entry => entry.id !== DEFAULT_REVIEW_WORKSPACE);
  if (!imported.length) return local;
  const decisions = new Map(local.decisions.map(decision => [decision.cardKey, decision]));
  for (const workspace of imported) for (const decision of workspace.decisions) {
    const held = decisions.get(decision.cardKey);
    if (!held || Date.parse(decision.updatedAt) > Date.parse(held.updatedAt)) decisions.set(decision.cardKey, decision);
  }
  return { ...local, decisions: [...decisions.values()] };
}

export function decisionFor(workspace: ReviewWorkspace, cardKey: string): CardDecision | null {
  return workspace.decisions.find(decision => decision.cardKey === cardKey) ?? null;
}

/**
 * Record (or clear, with `null`) one person's decision on a card. A refused
 * save stays visible as a staged draft with its native save state. The save
 * persists the folded review, then retires the imported copies it absorbed, so
 * a cleared card cannot reappear from an older imported decision.
 */
export async function saveCardDecision(cardKey: string, decision: { status: HumanStatus; comment: string } | null, now = new Date()): Promise<boolean> {
  const entries = useReviewWorkspaces.getState().entries;
  const workspace = currentReviewWorkspace(entries);
  const others = workspace.decisions.filter(entry => entry.cardKey !== cardKey);
  const next: ReviewWorkspace = { ...workspace, decisions: decision
    ? [...others, { cardKey, status: decision.status, comment: decision.comment.slice(0, REVIEW_LIMITS.comment), updatedAt: now.toISOString() }]
    : others };
  if (!decodeReviewWorkspace(next)) return false;
  if (!await reviewWorkspaceLibrary.put(next.id, next)) return false;
  const absorbed = entries.filter(entry => entry.id !== DEFAULT_REVIEW_WORKSPACE);
  return (await Promise.all(absorbed.map(entry => reviewWorkspaceLibrary.put(entry.id, null)))).every(Boolean);
}
