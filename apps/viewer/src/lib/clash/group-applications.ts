/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Durable receipts of reviewed AI clash groups applied to a native grouping
 * workspace (content kind `clashGroupApplications`). A receipt pins the
 * workspace revision it wrote and the complete partition it replaced, so undo
 * can restore exactly that partition and refuse when anything changed since.
 */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../storage/content-library';
import type { ContentDefinition } from '../storage/content-migration';
import { decodeClashGroupWorkspace, type ClashGroupWorkspace } from './group-workspace';

export interface ClashGroupApplication {
  version: 1;
  id: string;
  createdAt: string;
  /** Producer, e.g. the evidence snapshot id of the conversation or `classify-all`. */
  origin: string;
  source: 'sample' | 'full-run';
  /** A cancelled or failed full run applied only the chunks that completed. */
  partial: boolean;
  workspaceId: string;
  workspaceName: string;
  /** True when the apply created the workspace; undo then removes it. */
  created: boolean;
  baseRevision: number;
  /** The revision this apply wrote; undo refuses unless the workspace is still at it. */
  appliedRevision: number;
  /** The partition before apply; empty groups for a workspace that was never saved. Null when created. */
  before: ClashGroupWorkspace | null;
  after: ClashGroupWorkspace;
  /** Workspace group ids written from the reviewed proposal. */
  addedGroupIds: string[];
  /** Findings taken out of groups that existed before apply (explicitly confirmed). */
  movedFindings: number;
  /** FNV-1a hashes of every native occurrence at apply; null when the run was too large to record. */
  population: string[] | null;
  status: 'applied' | 'undone';
  undoneAt?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const POPULATION_LIMIT = 50_000;

export function decodeClashGroupApplication(value: unknown): ClashGroupApplication | null {
  if (!record(value) || value.version !== 1 || !text(value.id) || !text(value.createdAt, 64) || !text(value.origin)
    || (value.source !== 'sample' && value.source !== 'full-run') || typeof value.partial !== 'boolean'
    || !text(value.workspaceId) || !text(value.workspaceName) || typeof value.created !== 'boolean'
    || !count(value.baseRevision) || !count(value.appliedRevision) || value.appliedRevision !== value.baseRevision + 1
    || !count(value.movedFindings) || (value.status !== 'applied' && value.status !== 'undone')
    || (value.undoneAt !== undefined && !text(value.undoneAt, 64))) return null;
  const after = decodeClashGroupWorkspace(value.after);
  const before = value.before === null ? null : decodeClashGroupWorkspace(value.before);
  if (!after || after.id !== value.workspaceId || (value.before !== null && !before) || (before === null) !== value.created) return null;
  if (!Array.isArray(value.addedGroupIds) || value.addedGroupIds.length > 200 || !value.addedGroupIds.every(id => text(id))) return null;
  const population = value.population;
  if (population !== null && (!Array.isArray(population) || population.length > POPULATION_LIMIT
    || !population.every(hash => typeof hash === 'string' && /^[0-9a-f]{8}$/.test(hash)))) return null;
  return { version: 1, id: value.id, createdAt: value.createdAt, origin: value.origin, source: value.source, partial: value.partial,
    workspaceId: value.workspaceId, workspaceName: value.workspaceName, created: value.created, baseRevision: value.baseRevision,
    appliedRevision: value.appliedRevision, before, after, addedGroupIds: [...value.addedGroupIds as string[]],
    movedFindings: value.movedFindings, population: population === null ? null : [...population as string[]], status: value.status,
    ...(value.undoneAt !== undefined ? { undoneAt: value.undoneAt as string } : {}) };
}

export const clashGroupApplicationContent: ContentDefinition<ClashGroupApplication> = {
  kind: 'clashGroupApplications', legacyKey: 'ifc-lite-clash-group-applications-v1', decode: decodeClashGroupApplication,
};

export const useClashGroupApplications = create<{ entries: ClashGroupApplication[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const clashGroupApplicationLibrary = createContentLibrary(clashGroupApplicationContent,
  () => useClashGroupApplications.getState().entries,
  (entries, status) => useClashGroupApplications.setState({ entries, status }));

/** 32-bit FNV-1a, enough to tell findings that were present at apply from new ones. */
export function occurrenceHash(occurrence: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < occurrence.length; index++) {
    hash ^= occurrence.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
