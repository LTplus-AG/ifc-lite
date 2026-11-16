// SPDX-License-Identifier: MPL-2.0
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { effectiveReferencers } from '@ifc-lite/export';
import { refId } from '../host-geometry-frame.js';
import { attachedKind, attachedTopDependency } from './storey-attached.js';
import { gridPlacementParent, gridPlacementsOn } from './storey-grid.js';
import { countedElements, walkStoreyContents, type StoreyInventory } from './storey-model.js';
import { plannerCache } from './storey-inventory-cache.js';
import { StoreyPlannerIndex, type PlannerProduct } from './storey-planner-index.js';

type Walk = NonNullable<ReturnType<typeof walkStoreyContents>>;

/** Geometry payloads belong to the request reader, never this retained index.
 * Cold construction is linear. Subsequent floor edits reuse topology and
 * reclassify only changed product IDs, including skip-history and undo. */
export class StoreyPlanningInventory {
  inventoryProducts = 0;
  readonly index = new StoreyPlannerIndex();
  readonly walks = new Map<number, Walk>();
  readonly counts = new Map<number, number>();
  readonly types = new Map<number, string>();
  private readonly identities = new Map<number, string | null>();
  readonly parents = new Map<number, number | null>();
  readonly railingsByStorey = new Map<number, Set<number>>();
  private readonly children = new Map<number, number[]>();
  private readonly owners = new Map<number, number[]>();
  private readonly homes = new Map<number, number>();
  private readonly order = new Map<number, number>();
  private readonly multipleHomes = new Map<number, Map<number, number>>();
  private readonly aliases = new Map<number, Set<number>>();
  private readonly aliasSources = new Map<number, number>();
  private readonly specialDependents = new Set<number>();
  private readonly elementTargets = new Map<number, Set<number>>();
  private readonly elementTargetOf = new Map<number, number>();
  private revision = 0;
  private sequence = 0;

  constructor(inventory: StoreyInventory) {
    for (const storey of inventory.storeys) {
      const walk = walkStoreyContents(inventory, storey.expressId, Infinity)!;
      this.walks.set(storey.expressId, walk);
      this.counts.set(storey.expressId, countedElements(inventory, walk.contents));
      for (const id of walk.contents) {
        const rank = this.sequence++;
        const previous = this.homes.get(id);
        if (previous === undefined) { this.homes.set(id, storey.expressId); this.order.set(id, rank); }
        else {
          let homes = this.multipleHomes.get(id);
          if (!homes) this.multipleHomes.set(id, homes = new Map([[previous, this.order.get(id)!]]));
          homes.set(storey.expressId, rank);
        }
      }
    }
    const referencers = effectiveReferencers(inventory.store, inventory.view);
    for (const type of ['IFCLOCALPLACEMENT', 'IFCGRIDPLACEMENT']) for (const id of inventory.reader.ids(type)) {
      const parent = type === 'IFCLOCALPLACEMENT' ? refId(inventory.reader.entity(id)?.attributes[0])
        : gridPlacementParent(inventory.reader, referencers, id);
      this.parents.set(id, parent);
      if (parent !== null) this.append(this.children, parent, id);
    }
    const productTypes = new Map<string, boolean>();
    for (const row of iterateEffectiveEntityIds(inventory.store, inventory.view)) {
      let product = productTypes.get(row.type);
      if (product === undefined) productTypes.set(row.type, product = getInheritanceChainAcrossSchemas(row.type).includes('IfcProduct'));
      if (!product) continue;
      this.types.set(row.expressId, row.type.toUpperCase());
      const placement = refId(inventory.reader.entity(row.expressId)?.attributes[5]);
      if (placement !== null) {
        this.append(this.owners, placement, row.expressId);
        if (row.type.toUpperCase() === 'IFCGRID') for (const bound of gridPlacementsOn(inventory.reader, referencers, row.expressId)) {
          this.append(this.children, placement, bound);
        }
      }
    }
    this.update(inventory, this.types.keys());
    this.inventoryProducts = this.types.size;
  }
  private append(map: Map<number, number[]>, key: number, id: number): void {
    const bucket = map.get(key);
    if (bucket) bucket.push(id); else map.set(key, [id]);
  }
  private row(inventory: StoreyInventory, id: number): PlannerProduct {
    const entity = inventory.reader.entity(id)!;
    const type = entity.type.toUpperCase();
    this.types.set(id, type);
    this.identities.set(id, typeof entity.attributes[0] === 'string' ? entity.attributes[0] : null);
    const previousAlias = this.aliasSources.get(id);
    if (previousAlias !== undefined) this.aliases.get(previousAlias)?.delete(id);
    const alias = inventory.view.getEntityAlias(id);
    this.aliasSources.delete(id);
    if (alias !== null) {
      let copies = this.aliases.get(alias);
      if (!copies) this.aliases.set(alias, copies = new Set());
      copies.add(id); this.aliasSources.set(id, alias);
    }
    const storey = this.homes.get(id) ?? 0;
    const placement = refId(entity.attributes[5]);
    const parentPlacement = placement === null ? null : this.parents.get(placement) ?? null;
    const floor = inventory.storeys.find(s => s.expressId === storey)?.placementId;
    // Only a private local placement directly following its home storey is
    // omitted from the solver. Shared, grid, missing and indirect placements
    // retain the full placement solver and its refusal semantics.
    const exceptional = this.multipleHomes.has(id) || floor == null || placement === null || parentPlacement !== floor
      || inventory.reader.entity(placement)?.type.toUpperCase() !== 'IFCLOCALPLACEMENT'
      || this.owners.get(placement)?.length !== 1;
    const kind = attachedKind(type);
    const { attachment, problem } = kind ? attachedTopDependency(inventory, id) : { attachment: null, problem: null };
    const oldTarget = this.elementTargetOf.get(id);
    if (oldTarget !== undefined) this.elementTargets.get(oldTarget)?.delete(id);
    this.elementTargetOf.delete(id);
    const target = attachment?.targetElementId;
    if (target !== undefined) {
      let products = this.elementTargets.get(target);
      if (!products) this.elementTargets.set(target, products = new Set());
      products.add(id); this.elementTargetOf.set(id, target);
    }
    if (type === 'IFCSTAIR' || problem || this.multipleHomes.has(id)) this.specialDependents.add(id); else this.specialDependents.delete(id);
    if (type === 'IFCRAILING') for (const home of this.multipleHomes.get(id)?.keys() ?? [storey]) {
      let railings = this.railingsByStorey.get(home);
      if (!railings) this.railingsByStorey.set(home, railings = new Set());
      railings.add(id);
    }
    return { id, storey, placement, exceptional,
      attachmentTargets: attachment?.targetStoreyId == null ? [] : [attachment.targetStoreyId] };
  }
  update(inventory: StoreyInventory, ids: Iterable<number>): void {
    const rows: Array<readonly [number, PlannerProduct]> = [];
    const affected = new Set<number>();
    for (const id of ids) { affected.add(id); for (const copy of this.aliases.get(id) ?? []) affected.add(copy); }
    for (const id of affected) if (this.types.has(id)) rows.push([id, this.row(inventory, id)]);
    this.index.apply(this.revision, ++this.revision, rows);
    this.inventoryProducts = rows.length;
  }
  /** Preserve planners already borrowed by unchanged detached drafts. The
   * topology is immutable between rebuilds; only update-owned maps are copied. */
  updated(inventory: StoreyInventory, ids: Iterable<number>): StoreyPlanningInventory {
    const copy = Object.create(StoreyPlanningInventory.prototype) as StoreyPlanningInventory;
    Object.assign(copy, this, {
      index: this.index.copy(), types: new Map(this.types), identities: new Map(this.identities),
      aliases: new Map([...this.aliases].map(([id, copies]) => [id, new Set(copies)])),
      aliasSources: new Map(this.aliasSources), specialDependents: new Set(this.specialDependents),
      railingsByStorey: new Map([...this.railingsByStorey].map(([id, rows]) => [id, new Set(rows)])),
      elementTargets: new Map([...this.elementTargets].map(([id, rows]) => [id, new Set(rows)])),
      elementTargetOf: new Map(this.elementTargetOf),
    });
    copy.update(inventory, ids);
    return copy;
  }
  needsRebuild(inventory: StoreyInventory, ids: Iterable<number>): boolean {
    for (const id of ids) {
      const entity = inventory.reader.entity(id);
      const type = entity?.type.toUpperCase();
      if (this.parents.has(id) && type !== 'IFCLOCALPLACEMENT' && type !== 'IFCGRIDPLACEMENT') return true;
      if (this.types.has(id)) {
        if (type !== this.types.get(id) || refId(entity?.attributes[5]) !== this.index.get(id)?.placement) return true;
        // GUID bindings can become unresolved or resolve to another canonical
        // target, even when the edited product had no dependents before.
        const guid = typeof entity?.attributes[0] === 'string' ? entity.attributes[0] : null;
        if (guid !== this.identities.get(id)) return true;
      } else if (type && getInheritanceChainAcrossSchemas(type).includes('IfcProduct')) return true;
    }
    return false;
  }
  /** Same graph walk as the placement solver, over retained IDs only. */
  reached(placements: readonly number[]): number[] {
    const products = new Set<number>(), visited = new Set<number>(), queue = [...placements];
    while (queue.length) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const owner of this.owners.get(id) ?? []) products.add(owner);
      queue.push(...this.children.get(id) ?? []);
    }
    return [...products];
  }
  /** A placement-only floor edit can refit only these element-bound tops. */
  refreshCandidates(moved: Iterable<number>, refit: Iterable<number>): ReadonlyMap<number, number> {
    const result = new Map<number, number>();
    for (const target of moved) for (const product of this.elementTargets.get(target) ?? []) result.set(product, target);
    for (const product of refit) { const target = this.elementTargetOf.get(product); if (target !== undefined) result.set(product, target); }
    return result;
  }
  dependentCandidates(inventory: StoreyInventory, deltas: ReadonlyMap<number, number>): Map<number, number[]> {
    const selected = this.index.heightCandidates(deltas);
    for (const id of this.specialDependents) selected.add(id);
    const buckets = new Map<number, number[]>();
    for (const id of selected) for (const home of this.multipleHomes.get(id)?.keys() ?? [this.homes.get(id) ?? 0]) {
      this.append(buckets, home, id);
    }
    const result = new Map<number, number[]>();
    for (const storey of inventory.storeys) {
      const home = storey.expressId;
      const rank = (id: number) => this.multipleHomes.get(id)?.get(home) ?? this.order.get(id)!;
      result.set(home, (buckets.get(home) ?? []).sort((a, b) => rank(a) - rank(b)));
    }
    return result;
  }
}

export function storeyPlanningInventory(inventory: StoreyInventory): StoreyPlanningInventory {
  const cache = plannerCache(inventory);
  let index = cache.value instanceof StoreyPlanningInventory && !cache.value.needsRebuild(inventory, cache.dirty)
    ? cache.value : new StoreyPlanningInventory(inventory);
  if (cache.value === index) {
    if (cache.dirty.size) index = index.updated(inventory, cache.dirty);
    else index.inventoryProducts = 0;
  }
  cache.save(index, index.parents);
  return index;
}
