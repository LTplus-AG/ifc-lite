// SPDX-License-Identifier: MPL-2.0
/** #8452 preparation only. The planner adapter will supply effective records
 * after #10132 merges. No planner reads this prototype yet. */
export interface PlannerProduct {
  readonly id: number;
  readonly storey: number;
  readonly placement: number | null;
  readonly parentPlacement: number | null;
  readonly attachmentTargets: readonly number[];
  /** Non-inheriting/shared/grid/ambiguous placements need detailed planning. */
  readonly exceptional: boolean;
}
type Buckets = Map<number, Set<number>>;
export class StoreyPlannerIndex {
  private readonly products = new Map<number, PlannerProduct>();
  private readonly contents: Buckets = new Map();
  private readonly exceptions: Buckets = new Map();
  private readonly attachmentPairs = new Map<number, Buckets>();
  private readonly placements: Buckets = new Map();
  private readonly parents: Buckets = new Map();
  private readonly unresolved = new Set<number>();
  private revision = 0;
  private update(bucket: Buckets, key: number, id: number, add: boolean): void {
    if (add) { let ids = bucket.get(key); if (!ids) bucket.set(key, ids = new Set()); ids.add(id); }
    else { const ids = bucket.get(key); ids?.delete(id); if (!ids?.size) bucket.delete(key); }
  }
  private index(p: PlannerProduct, add: boolean): void {
    this.update(this.contents, p.storey, p.id, add);
    if (p.exceptional) this.update(this.exceptions, p.storey, p.id, add);
    for (const target of p.attachmentTargets) {
      let owners = this.attachmentPairs.get(target);
      if (!owners && add) this.attachmentPairs.set(target, owners = new Map());
      if (owners) {
        this.update(owners, p.storey, p.id, add);
        if (!owners.size) this.attachmentPairs.delete(target);
      }
    }
    if (p.placement === null) { if (add) this.unresolved.add(p.id); else this.unresolved.delete(p.id); }
    else this.update(this.placements, p.placement, p.id, add);
    if (p.parentPlacement !== null) this.update(this.parents, p.parentPlacement, p.id, add);
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
  /** Public moved IDs still include inherited products, without payload reads. */
  *moved(storeys: Iterable<number>): Iterable<number> {
    const seen = new Set<number>();
    for (const storey of storeys) for (const id of this.contents.get(storey) ?? []) if (!seen.has(id)) { seen.add(id); yield id; }
  }
  /** Equal owner/target deltas leave attachment heights unchanged. Inspect
   * storey-pair groups, never every product in the unchanged groups. */
  heightCandidates(deltas: ReadonlyMap<number, number>): Set<number> {
    const ids = new Set(this.unresolved);
    for (const [target, owners] of this.attachmentPairs) for (const [owner, products] of owners) {
      if ((deltas.get(target) ?? 0) !== (deltas.get(owner) ?? 0)) for (const id of products) ids.add(id);
    }
    return ids;
  }
  /** Only exceptional placement owners, affected targets and placement
   * descendants need detailed planning. Missing placements remain refusals. */
  /** This convenience query assumes one common shift; callers with different
   * deltas use heightCandidates with their full delta map. */
  candidates(storeys: Iterable<number>, changedPlacements: Iterable<number>): Set<number> {
    const shifted = [...storeys];
    const ids = this.heightCandidates(new Map(shifted.map(id => [id, 1]))), queue = [...changedPlacements], visited = new Set<number>();
    for (const storey of shifted) for (const id of this.exceptions.get(storey) ?? []) ids.add(id);
    while (queue.length) {
      const placement = queue.pop()!;
      if (visited.has(placement)) continue;
      visited.add(placement);
      for (const id of this.placements.get(placement) ?? []) ids.add(id);
      for (const id of this.parents.get(placement) ?? []) {
        ids.add(id);
        const child = this.products.get(id)?.placement;
        if (child !== null && child !== undefined) queue.push(child);
      }
    }
    return ids;
  }
}
