/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { reviewSHA256 } from './capture-budget.js';
import { targetState, type NativeReviewTarget } from './capture-ownership.js';
import type { NativeReviewModel } from './capture-types.js';

export type PortableOwnerRefusal = 'work-bound' | 'source-unavailable' | 'target-changed' | 'scope'
  | 'model-edited' | 'identity-unavailable' | 'identity-ambiguous' | 'source-ambiguous' | 'aborted';
export interface PortableOwner {
  model: NativeReviewModel;
  sourceSHA256: string;
  /** Complete, duplicate-checked actual rows, never a last-write point lookup. */
  identities: ReadonlyMap<string, number>;
  GlobalIds: ReadonlyMap<number, string>;
}
type OwnerResult<T> = { ok: true; value: T } | { ok: false; refusal: PortableOwnerRefusal };
const refused = (refusal: PortableOwnerRefusal) => ({ ok: false, refusal } as const);

/** Read-only source binding does not attest that an imported producer ran.
 * All target leases are acquired synchronously before the FIRST source await.
 * Projection stays inside the final lease/permission check's synchronous turn.
 */
export async function withPortableOwners<T>(liveModels: () => readonly NativeReviewModel[], allowed: (id: string) => boolean,
  project: (owners: readonly PortableOwner[]) => T, signal?: AbortSignal): Promise<OwnerResult<T>> {
  try { return await readOwners(liveModels, allowed, project, signal); }
  catch {
    console.warn('Portable Review ownership is unavailable; imported evidence remains unbound.');
    return refused(signal?.aborted ? 'aborted' : 'source-unavailable');
  }
}
async function readOwners<T>(liveModels: () => readonly NativeReviewModel[], allowed: (id: string) => boolean,
  project: (owners: readonly PortableOwner[]) => T, signal?: AbortSignal): Promise<OwnerResult<T>> {
  const models = liveModels();
  // The same model/source/value bounds as native Review. No partial index.
  if (models.length > 64 || models.some(model => model.id.length > 1_024 || model.name.length > 4_096)
    || models.reduce((sum, model) => sum + model.source.byteLength, 0) > 67_108_864) return refused('work-bound');
  if (new Set(models.map(model => model.id)).size !== models.length) return refused('identity-ambiguous');
  const targets: Array<NativeReviewTarget & { identity: NonNullable<NativeReviewModel['identityTable']> }> = [];
  let declaredRows = 0;
  for (const model of models) {
    if (!allowed(model.id)) return refused('scope');
    if (!model.source.byteLength || !model.source.contentKey) return refused('source-unavailable');
    const view = model.mutationView(), revision = view?.getMutationRevision() ?? 0;
    // A source-file hash cannot describe edited geometry/attributes.
    if (revision !== 0) return refused('model-edited');
    const identity = model.identityTable;
    if (!identity || !Number.isSafeInteger(identity.count) || identity.count < 0) return refused('identity-unavailable');
    declaredRows += identity.count;
    if (declaredRows > 100_000) return refused('work-bound');
    targets.push({ model, view, revision, identity });
  }
  const ownership = (): PortableOwnerRefusal | null => {
    if (signal?.aborted) return 'aborted';
    const current = liveModels();
    if (current.length !== models.length || current.length > 64) return 'target-changed';
    for (const target of targets) {
      if (!allowed(target.model.id)) return 'scope';
      const live = current.find(model => model.id === target.model.id);
      if (targetState(target, current).stale || live?.identityTable?.owner !== target.identity.owner
        || live.identityTable.count !== target.identity.count
        || live.identityTable.expressIdColumn !== target.identity.expressIdColumn
        || live.identityTable.GlobalIdColumn !== target.identity.GlobalIdColumn
        || live.identityTable.stringTable !== target.identity.stringTable) return 'target-changed';
    }
    return null;
  };
  const owners: PortableOwner[] = [];
  const hashes = new Set<string>();
  let rows = 0, identityText = 0;
  try {
    for (const target of targets) {
      const before = ownership();
      if (before) return refused(before);
      const sourceSHA256 = await target.model.source.withMaterializedAsync(reviewSHA256);
      const after = ownership();
      if (after) return refused(after);
      if (hashes.has(sourceSHA256)) return refused('source-ambiguous');
      hashes.add(sourceSHA256);
      const identities = new Map<string, number>(), GlobalIds = new Map<number, string>(), expressIds = new Set<number>();
      let modelRows = 0;
      for (const row of target.identity.rows()) {
        if (++rows > 100_000 || ++modelRows > target.identity.count) return refused('work-bound');
        if (!Number.isSafeInteger(row.expressId) || row.expressId <= 0 || typeof row.GlobalId !== 'string'
          || row.GlobalId.length > 200) return refused('identity-unavailable');
        if ((identityText += row.GlobalId.length) > 1_048_576) return refused('work-bound');
        if (expressIds.has(row.expressId)) return refused('identity-ambiguous');
        expressIds.add(row.expressId);
        // Non-root entities legitimately have no IFC GlobalId.
        if (!row.GlobalId) continue;
        if (identities.has(row.GlobalId)) return refused('identity-ambiguous');
        identities.set(row.GlobalId, row.expressId);
        GlobalIds.set(row.expressId, row.GlobalId);
      }
      if (modelRows !== target.identity.count) return refused('identity-unavailable');
      owners.push({ model: target.model, sourceSHA256, identities, GlobalIds });
    }
    const final = ownership();
    if (final) return refused(final);
    const value = project(owners);
    const projected = ownership();
    return projected ? refused(projected) : { ok: true, value };
  } catch {
    // No source/adapter exception or unauthorized name leaves this boundary.
    console.warn('Portable Review source or identity read failed; imported evidence remains unbound.');
    return refused(signal?.aborted ? 'aborted' : 'source-unavailable');
  }
}
