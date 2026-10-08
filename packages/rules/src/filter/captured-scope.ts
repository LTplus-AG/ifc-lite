/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { storeHasSourceEntity, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

/** A pinned population, independent of later selection and visibility (#7186).
 * Source identity is the host's full-content identity, never a sampled hash.
 * Authored members additionally name their original CREATE_ENTITY journal id. */
export interface CapturedEntityScope {
  version: 1;
  mode: 'selected' | 'visible';
  capturedAt: number;
  sources: Array<{
    sourceFingerprint: string;
    sourceContentHash: string;
    members: Array<{ expressId: number; creationId?: string }>;
  }>;
}

export const MAX_CAPTURED_SCOPE_MEMBERS = 20_000;
const MAX_SOURCES = 1_024;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Shared storage/import boundary. Malformed snapshots must never become all. */
export function isCapturedEntityScope(value: unknown): value is CapturedEntityScope {
  if (!record(value) || value.version !== 1 || !['selected', 'visible'].includes(String(value.mode))
    || typeof value.capturedAt !== 'number' || !Number.isFinite(value.capturedAt) || value.capturedAt <= 0
    || !Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > MAX_SOURCES) return false;
  let count = 0;
  const identities = new Set<string>();
  for (const source of value.sources) {
    if (!record(source) || !text(source.sourceFingerprint, 2_048) || !text(source.sourceContentHash, 256)
      || !Array.isArray(source.members) || source.members.length === 0
      || (count += source.members.length) > MAX_CAPTURED_SCOPE_MEMBERS) return false;
    const identity = JSON.stringify([source.sourceFingerprint, source.sourceContentHash]);
    if (identities.has(identity)) return false;
    identities.add(identity);
    const ids = new Set<number>();
    for (const member of source.members) {
      if (!record(member) || typeof member.expressId !== 'number' || !Number.isSafeInteger(member.expressId)
        || member.expressId <= 0 || ids.has(member.expressId)
        || (member.creationId !== undefined && !text(member.creationId, 256))) return false;
      ids.add(member.expressId);
    }
  }
  return true;
}

/** Structural host input shared by filter, Lists, and Lens native paths. */
export interface CapturedScopeModel {
  id: string;
  filterIdentity?: string;
  sourceContentHash?: string;
  store: IfcDataStore | null;
  mutationView?: MutablePropertyView;
}

/** Resolve every captured member before running anything. Every loaded model
 * receives a key, including empty populations, because Rules' missing-key
 * candidate semantics otherwise fall back to all entities. */
export function resolveCapturedEntityScope(
  scope: CapturedEntityScope,
  models: readonly CapturedScopeModel[],
): Map<string, Set<number>> {
  if (!isCapturedEntityScope(scope)) throw new Error('Captured scope is malformed. Clear it or capture the population again.');
  const resolved = new Map(models.map(model => [model.id, new Set<number>()]));
  for (const source of scope.sources) {
    const matches = models.filter(model => model.filterIdentity === source.sourceFingerprint
      && model.sourceContentHash === source.sourceContentHash);
    if (matches.length !== 1) throw new Error('Captured scope source is missing, replaced, or ambiguous. Load its original source or capture again.');
    const model = matches[0];
    if (!model.store) throw new Error('Captured scope source data is unavailable. Nothing was run.');
    const creations = new Map<number, string>();
    // One journal pass per source, never one history scan per member.
    if (source.members.some(member => member.creationId !== undefined)) {
      for (const mutation of model.mutationView?.getMutations() ?? []) {
        if (mutation.type === 'CREATE_ENTITY') creations.set(mutation.entityId, mutation.id);
      }
    }
    for (const member of source.members) {
      const created = model.mutationView?.getNewEntity(member.expressId);
      const exists = member.creationId === undefined
        ? !created && storeHasSourceEntity(model.store, member.expressId)
        : !!created && creations.get(member.expressId) === member.creationId;
      if (!exists || model.mutationView?.isDeleted(member.expressId)) {
        throw new Error(`Captured scope member #${member.expressId} is missing or its authored identity changed. Nothing was run.`);
      }
      resolved.get(model.id)!.add(member.expressId);
    }
  }
  return resolved;
}
