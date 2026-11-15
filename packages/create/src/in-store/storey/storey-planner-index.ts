// SPDX-License-Identifier: MPL-2.0
import { storeyDeltasDiffer } from './storey-validation.js';
/** Compact effective product inventory for storey planning (#8452). */
export interface PlannerProduct {
  readonly id: number;
  readonly storey: number;
  readonly placement: number | null;
  readonly attachmentTargets: readonly number[];
  /** Non-inheriting/shared/grid/ambiguous placements need detailed planning. */
  readonly exceptional: boolean;
}
type Buckets = Map<number, Set<number>>;
export class StoreyPlannerIndex {
  private readonly products = new Map<number, PlannerProduct>();
  private readonly attachmentPairs = new Map<number, Buckets>();
  private readonly unresolved = new Set<number>();
  private revision = 0;
  get(id: number): PlannerProduct | undefined { return this.products.get(id); }
  private update(bucket: Buckets, key: number, id: number, add: boolean): void {
    if (add) { let ids = bucket.get(key); if (!ids) bucket.set(key, ids = new Set()); ids.add(id); }
    else { const ids = bucket.get(key); ids?.delete(id); if (!ids?.size) bucket.delete(key); }
  }
  private index(p: PlannerProduct, add: boolean): void {
    for (const target of p.attachmentTargets) {
      let owners = this.attachmentPairs.get(target);
      if (!owners && add) this.attachmentPairs.set(target, owners = new Map());
      if (owners) {
        this.update(owners, p.storey, p.id, add);
        if (!owners.size) this.attachmentPairs.delete(target);
      }
    }
    if (p.placement === null) { if (add) this.unresolved.add(p.id); else this.unresolved.delete(p.id); }
  }
  /** Supply full effective rows for changed IDs; null deletes. Continuity is
   * explicit: undo/restore can supply inverse rows or reset to a new snapshot.
   * Validate/materialize the whole batch before publishing any index changes. */
  apply(from: number, to: number, changes: Iterable<readonly [number, PlannerProduct | null]>): void {
    if (from !== this.revision || to <= from) throw new Error('Planner inventory continuity lost; rebuild required');
    const batch = Array.from(changes, ([id, p]) => {
      if (p && p.id !== id) throw new Error('Planner inventory ID mismatch');
      return [id, p ? Object.freeze({ ...p, attachmentTargets: Object.freeze([...p.attachmentTargets]) }) : null] as const;
    });
    for (const [id, p] of batch) {
      const old = this.products.get(id);
      if (old) this.index(old, false);
      this.products.delete(id);
      if (p) { this.products.set(id, p); this.index(p, true); }
    }
    this.revision = to;
  }
  /** Equal owner/target deltas leave attachment heights unchanged. Inspect
   * storey-pair groups, never every product in the unchanged groups. */
  heightCandidates(deltas: ReadonlyMap<number, number>): Set<number> {
    const ids = new Set(this.unresolved);
    for (const [target, owners] of this.attachmentPairs) for (const [owner, products] of owners) {
      if (storeyDeltasDiffer(deltas.get(owner) ?? 0, deltas.get(target) ?? 0)) for (const id of products) ids.add(id);
    }
    return ids;
  }
}
