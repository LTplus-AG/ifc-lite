/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three-way merge: two runs of the two-way comparison joined on identity,
 * iterated over the union of touched (entity, componentKey) pairs.
 *
 * Inputs: ancestor A = the candidate layer's base, ours O = the target
 * ref's state, theirs T = the candidate applied to A. The plan's autoOps
 * apply on top of O; "keep ours" therefore emits nothing.
 *
 * Decision matrix (05 §5.3):
 *
 *   A→O unchanged, A→T changed            → take theirs (auto)
 *   A→O changed,  A→T unchanged           → keep ours (auto)
 *   both changed, equal sub-hash          → fold (auto)
 *   both changed, different               → conflict: concurrent-edit
 *   tombstoned vs changed                 → conflict: delete-vs-modify
 *   changed vs tombstoned                 → conflict: modify-vs-delete
 *   tombstoned vs tombstoned              → fold (auto)
 *
 * Relations use the same matrix over `child:<name>` slots; divergent
 * reparenting surfaces as a `hierarchy` conflict.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import type {
  ComponentAttributes,
  ComponentKey,
  MergeConflict,
  MergeOp,
  MergePlan,
} from './types.js';
import type { EntityState, StackState } from './component-state.js';
import {
  componentEntries,
  extractStackState,
  projectStackStates,
  snapshotOf,
} from './component-state.js';

export interface ThreeWayInputs {
  /** The candidate layer's base, ordered weakest first. */
  ancestor: readonly IfcxFile[];
  /** The target ref's state, ordered weakest first. */
  ours: readonly IfcxFile[];
  /** The candidate applied to its base, ordered weakest first. */
  theirs: readonly IfcxFile[];
}

export function planThreeWayMerge(inputs: ThreeWayInputs): MergePlan {
  // Fast path (05 §5.7): when both sides extend the ancestor stack, only
  // suffix-touched paths can differ — project those instead of folding
  // and hashing the full model three times. Falls back to the reference
  // extraction for tombstone-bearing stacks (subtree shadowing is global)
  // and for unrelated stacks. Equivalence is enforced by the differential
  // fuzz in fast-path-differential.test.ts.
  if (sharesAncestorPrefix(inputs.ours, inputs.ancestor) && sharesAncestorPrefix(inputs.theirs, inputs.ancestor)) {
    const projected = projectStackStates(
      inputs.ancestor,
      inputs.ours.slice(inputs.ancestor.length),
      inputs.theirs.slice(inputs.ancestor.length)
    );
    if (projected) return planFromStates(projected.a, projected.o, projected.t);
  }
  return planFromStates(
    extractStackState(inputs.ancestor),
    extractStackState(inputs.ours),
    extractStackState(inputs.theirs)
  );
}

/**
 * True when `stack` starts with the ancestor's layers: same documents by
 * reference, or by content address (equal blake3 ids imply identical
 * canonical bytes; non-blake3 test ids only count when reference-equal).
 */
function sharesAncestorPrefix(stack: readonly IfcxFile[], ancestor: readonly IfcxFile[]): boolean {
  if (stack.length < ancestor.length) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (stack[i] === ancestor[i]) continue;
    const id = ancestor[i].header.id;
    if (id.startsWith('blake3:') && stack[i].header.id === id) continue;
    return false;
  }
  return true;
}

export function planFromStates(a: StackState, o: StackState, t: StackState): MergePlan {
  const autoOps: MergeOp[] = [];
  const conflicts: MergeConflict[] = [];
  let touched = 0;

  // Memoized per plan: with the projection sharing untouched component
  // objects across sides, reference equality + this cache keep hashing
  // proportional to the number of actually-edited components.
  const hashes = new WeakMap<ComponentAttributes, string>();
  const hashOf = (attrs: ComponentAttributes | undefined): string | undefined => {
    if (attrs === undefined) return undefined;
    let hash = hashes.get(attrs);
    if (hash === undefined) {
      hash = snapshotOf(attrs).hash;
      hashes.set(attrs, hash);
    }
    return hash;
  };

  const paths = new Set<string>([...a.keys(), ...o.keys(), ...t.keys()]);
  for (const path of paths) {
    const result = mergeEntity(path, a.get(path), o.get(path), t.get(path), hashOf);
    autoOps.push(...result.ops);
    conflicts.push(...result.conflicts);
    touched += result.touched;
  }

  const escalated = escalateShadowedConflicts(a, o, t, autoOps, conflicts);

  return {
    autoOps: escalated.autoOps,
    conflicts: escalated.conflicts,
    stats: {
      touched,
      autoMerged: escalated.autoOps.length,
      conflicting: escalated.conflicts.length,
    },
  };
}

/**
 * A conflict on a path that is SHADOW-dead on one side cannot be decided
 * on its own: subtree shadowing beats a child resurrect at composition
 * time, so any per-child resolution against a dead ancestor is a silent
 * no-op. The decision belongs to the tombstoned root:
 *
 * - Theirs tombstoned root R, ours edited descendants → R's auto
 *   tombstone is demoted to a `modify-vs-delete` conflict on R and the
 *   descendant conflicts fold into it (`subtree`): resolving R = theirs
 *   deletes the subtree knowingly; R = ours keeps it, edits and all.
 * - Ours tombstoned root R, theirs edited descendants → R gains a
 *   `delete-vs-modify` conflict (it had none: theirs never touched R
 *   itself). The descendant conflicts stay — their theirs-resolutions
 *   carry the actual edits and become satisfiable once R is resurrected.
 */
function escalateShadowedConflicts(
  a: StackState,
  o: StackState,
  t: StackState,
  autoOps: MergeOp[],
  conflicts: MergeConflict[]
): { autoOps: MergeOp[]; conflicts: MergeConflict[] } {
  const shadowDeadIn = (state: StackState, path: string): boolean => {
    const entity = state.get(path);
    return entity !== undefined && entity.deleted && !entity.explicitDeleted;
  };
  const needsPass = conflicts.some(
    (c) => c.componentKey === undefined && (shadowDeadIn(t, c.path) || shadowDeadIn(o, c.path))
  );
  if (!needsPass) return { autoOps, conflicts };

  const parentMaps = new Map<StackState, Map<string, string>>();
  const parentsOf = (state: StackState): Map<string, string> => {
    let parents = parentMaps.get(state);
    if (!parents) {
      parents = new Map<string, string>();
      for (const entity of state.values()) {
        for (const child of entity.children.values()) {
          if (!parents.has(child)) parents.set(child, entity.path);
        }
      }
      parentMaps.set(state, parents);
    }
    return parents;
  };
  const rootIn = (state: StackState, path: string): string | undefined => {
    // Nearest ancestor (via the state's children graph) whose death is
    // explicit on its own path.
    const parents = parentsOf(state);
    const seen = new Set<string>([path]);
    let current = parents.get(path);
    while (current !== undefined && !seen.has(current)) {
      const entity = state.get(current);
      if (entity?.explicitDeleted) return current;
      seen.add(current);
      current = parents.get(current);
    }
    return undefined;
  };

  const keptConflicts: MergeConflict[] = [];
  // Root path → descendant conflict paths folded into its decision.
  const theirsRoots = new Map<string, string[]>();
  const oursRoots = new Map<string, string[]>();

  for (const conflict of conflicts) {
    if (conflict.componentKey === undefined && shadowDeadIn(t, conflict.path)) {
      const root = rootIn(t, conflict.path);
      if (root !== undefined) {
        // Folded into the root's decision; the ours-side edits need no
        // ops (they are already in the target stack).
        const list = theirsRoots.get(root) ?? [];
        list.push(conflict.path);
        theirsRoots.set(root, list);
        continue;
      }
    }
    if (conflict.componentKey === undefined && shadowDeadIn(o, conflict.path)) {
      const root = rootIn(o, conflict.path);
      if (root !== undefined) {
        const list = oursRoots.get(root) ?? [];
        list.push(conflict.path);
        oursRoots.set(root, list);
        // Kept: its theirs-resolution carries the descendant's edits.
        keptConflicts.push(conflict);
        continue;
      }
    }
    keptConflicts.push(conflict);
  }

  let ops = autoOps;
  for (const [root, subtree] of theirsRoots) {
    ops = ops.filter((op) => !(op.op === 'tombstone-entity' && op.path === root));
    const existing = keptConflicts.find((c) => c.path === root && c.componentKey === undefined);
    if (existing) {
      existing.subtree = [...(existing.subtree ?? []), ...subtree].sort();
      continue;
    }
    const oEntity = o.get(root);
    const aEntity = a.get(root);
    keptConflicts.push({
      kind: 'modify-vs-delete',
      path: root,
      ours: snapshotOf(Object.fromEntries(componentsOf(oEntity).entries())),
      ...(aEntity && !aEntity.deleted
        ? { base: snapshotOf(Object.fromEntries(componentsOf(aEntity).entries())) }
        : {}),
      subtree: subtree.sort(),
    });
  }
  for (const [root, subtree] of oursRoots) {
    const existing = keptConflicts.find((c) => c.path === root && c.componentKey === undefined);
    if (existing) {
      existing.subtree = [...(existing.subtree ?? []), ...subtree].sort();
      continue;
    }
    const tEntity = t.get(root);
    const oEntity = o.get(root);
    const aEntity = a.get(root);
    keptConflicts.push({
      kind: 'delete-vs-modify',
      path: root,
      theirs: snapshotOf(Object.fromEntries(componentsOf(tEntity).entries())),
      ours: snapshotOf(Object.fromEntries(componentsOf(oEntity).entries())),
      ...(aEntity && !aEntity.deleted
        ? { base: snapshotOf(Object.fromEntries(componentsOf(aEntity).entries())) }
        : {}),
      subtree: subtree.sort(),
    });
  }

  return { autoOps: ops, conflicts: keptConflicts };
}

type HashOf = (attrs: ComponentAttributes | undefined) => string | undefined;

interface EntityMergeResult {
  ops: MergeOp[];
  conflicts: MergeConflict[];
  touched: number;
}

function alive(entity: EntityState | undefined): boolean {
  return entity !== undefined && !entity.deleted;
}

function componentsOf(entity: EntityState | undefined): Map<ComponentKey, ComponentAttributes> {
  return entity ? componentEntries(entity) : new Map();
}

function componentsEqual(
  x: Map<ComponentKey, ComponentAttributes>,
  y: Map<ComponentKey, ComponentAttributes>,
  hashOf: HashOf
): boolean {
  if (x.size !== y.size) return false;
  for (const [key, attrs] of x) {
    const other = y.get(key);
    if (!other) return false;
    if (other === attrs) continue;
    if (hashOf(other) !== hashOf(attrs)) return false;
  }
  return true;
}

function mergeEntity(
  path: string,
  aEntity: EntityState | undefined,
  oEntity: EntityState | undefined,
  tEntity: EntityState | undefined,
  hashOf: HashOf
): EntityMergeResult {
  const aAlive = alive(aEntity);
  const oAlive = alive(oEntity);
  const tAlive = alive(tEntity);
  const aComponents = componentsOf(aEntity);
  const oComponents = componentsOf(oEntity);
  const tComponents = componentsOf(tEntity);

  // Both sides agree the entity is gone (or never both created it): fold.
  // Component edits under a double-sided tombstone are unobservable and
  // fold with the deletion.
  if (!oAlive && !tAlive) return { ops: [], conflicts: [], touched: aAlive ? 1 : 0 };

  // A change is a component edit OR an alive-state flip: a resurrection
  // carries no component delta but is still a change (05 §5.3) — comparing
  // components alone would silently drop it (or worse, re-delete it).
  const oChanged = oAlive !== aAlive || !componentsEqual(aComponents, oComponents, hashOf);
  const tChanged = tAlive !== aAlive || !componentsEqual(aComponents, tComponents, hashOf);

  // Theirs didn't touch it (same alive-state, same components as the
  // ancestor): whatever ours did stands. Covers ours-only adds, edits,
  // deletes AND resurrections.
  if (!tChanged) return { ops: [], conflicts: [], touched: oChanged ? 1 : 0 };

  // Ours didn't touch it: take theirs wholesale.
  if (!oChanged) {
    if (oAlive && !tAlive) {
      // Theirs stripped it to an empty shell (nulled every attribute and
      // slot; the extraction drops such entities, no tombstone): express
      // that as removal opinions. A tombstone here would shadow-kill
      // children theirs kept alive.
      if (tEntity === undefined) {
        return {
          ops: opsForComponentDelta(path, aComponents, new Map(), oComponents, hashOf),
          conflicts: [],
          touched: 1,
        };
      }
      // Shadow-only deaths (a deleted ancestor node, not a tombstone on
      // this path) emit nothing: the parent's own merge decision carries
      // the subtree at composition time. Emitting here would re-delete a
      // child the target reparented, or pre-empt a parent still in
      // conflict.
      if (tEntity.deleted && !tEntity.explicitDeleted) {
        return { ops: [], conflicts: [], touched: 1 };
      }
      return { ops: [{ op: 'tombstone-entity', path }], conflicts: [], touched: 1 };
    }
    // Theirs is alive: added, resurrected, and/or edited.
    const ops: MergeOp[] = [];
    if (oEntity?.deleted === true || aEntity?.deleted === true) {
      ops.push({ op: 'resurrect-entity', path });
    }
    ops.push(...opsForComponentDelta(path, aComponents, tComponents, oComponents, hashOf));
    return { ops, conflicts: [], touched: 1 };
  }

  // Both changed. Convergent outcomes fold.
  if (oAlive === tAlive && componentsEqual(oComponents, tComponents, hashOf)) {
    return { ops: [], conflicts: [], touched: 1 };
  }

  // Ours deleted (or still dead) while theirs edited/resurrected.
  if (!oAlive && tAlive) {
    return {
      ops: [],
      conflicts: [
        {
          kind: 'delete-vs-modify',
          path,
          theirs: snapshotOf(Object.fromEntries(tComponents.entries())),
          // Ours' opinions stay in the stack under the tombstone and become
          // visible again on resurrect — resolutions need them to null out.
          ours: snapshotOf(Object.fromEntries(oComponents.entries())),
          ...(aAlive ? { base: snapshotOf(Object.fromEntries(aComponents.entries())) } : {}),
        },
      ],
      touched: 1,
    };
  }

  // Ours edited/resurrected while theirs deleted.
  if (oAlive && !tAlive) {
    return {
      ops: [],
      conflicts: [
        {
          kind: 'modify-vs-delete',
          path,
          ours: snapshotOf(Object.fromEntries(oComponents.entries())),
          ...(aAlive ? { base: snapshotOf(Object.fromEntries(aComponents.entries())) } : {}),
          // A shell-strip (no tombstone) records an empty theirs state so
          // a theirs-resolution emits removal opinions, not a tombstone
          // that would shadow-kill children theirs kept alive.
          ...(tEntity === undefined ? { theirs: snapshotOf({}) } : {}),
        },
      ],
      touched: 1,
    };
  }

  // Both alive: component-level matrix over the union of touched keys.
  const ops: MergeOp[] = [];
  const conflicts: MergeConflict[] = [];
  let touched = 0;
  const keys = new Set<ComponentKey>([
    ...aComponents.keys(),
    ...oComponents.keys(),
    ...tComponents.keys(),
  ]);

  for (const key of keys) {
    const aAttrs = aComponents.get(key);
    const oAttrs = oComponents.get(key);
    const tAttrs = tComponents.get(key);
    // Reference equality first (shared objects from the projection fast
    // path); only genuinely diverging references pay for hashing.
    if (aAttrs === oAttrs && aAttrs === tAttrs) continue;
    const oChanged = aAttrs === oAttrs ? false : hashOf(aAttrs) !== hashOf(oAttrs);
    const tChanged = aAttrs === tAttrs ? false : hashOf(aAttrs) !== hashOf(tAttrs);
    if (!oChanged && !tChanged) continue;
    touched += 1;

    if (oChanged && !tChanged) continue; // keep ours
    if (oChanged && tChanged && (oAttrs === tAttrs || hashOf(oAttrs) === hashOf(tAttrs))) continue; // fold

    if (!oChanged && tChanged) {
      ops.push(...opsForComponentChange(path, key, aAttrs, tAttrs, oAttrs));
      continue;
    }

    // Both changed, different values.
    conflicts.push({
      kind: key.startsWith('child:') || key.startsWith('inherit:') ? 'hierarchy' : 'concurrent-edit',
      path,
      componentKey: key,
      ...(aAttrs ? { base: snapshotOf(aAttrs) } : {}),
      ...(oAttrs ? { ours: snapshotOf(oAttrs) } : {}),
      ...(tAttrs ? { theirs: snapshotOf(tAttrs) } : {}),
    });
  }

  return { ops, conflicts, touched };
}

/**
 * Ops that transform an entity's components from the ancestor state to the
 * theirs state, given that ours matches the ancestor per entity-level
 * change detection. Emits only genuinely differing keys.
 */
function opsForComponentDelta(
  path: string,
  ancestor: Map<ComponentKey, ComponentAttributes>,
  theirs: Map<ComponentKey, ComponentAttributes>,
  ours: Map<ComponentKey, ComponentAttributes>,
  hashOf: HashOf
): MergeOp[] {
  const ops: MergeOp[] = [];
  const keys = new Set<ComponentKey>([...ancestor.keys(), ...theirs.keys()]);
  for (const key of keys) {
    const aAttrs = ancestor.get(key);
    const tAttrs = theirs.get(key);
    if (aAttrs === tAttrs) continue;
    if (aAttrs !== undefined && tAttrs !== undefined && hashOf(aAttrs) === hashOf(tAttrs)) continue;
    ops.push(...opsForComponentChange(path, key, aAttrs, tAttrs, ours.get(key)));
  }
  return ops;
}

/**
 * Ops that move one component from its ancestor value to the new value.
 *
 * The emitted node applies on top of the TARGET stack, where composition
 * is per-attribute LWW — setting the surviving attributes alone would
 * leave stale opinions (an attribute the candidate removed, or one ours
 * added inside a component being resolved to theirs) shining through.
 * Every key visible on the ancestor or ours side that `next` no longer
 * carries is therefore explicitly nulled.
 */
export function opsForComponentChange(
  path: string,
  componentKey: ComponentKey,
  ancestor: ComponentAttributes | undefined,
  next: ComponentAttributes | undefined,
  oursVisible?: ComponentAttributes
): MergeOp[] {
  if (componentKey.startsWith('child:')) {
    const name = componentKey.slice('child:'.length);
    if (next === undefined) return [{ op: 'remove-child', path, name }];
    return [{ op: 'set-child', path, name, child: String(next.child) }];
  }
  if (componentKey.startsWith('inherit:')) {
    const name = componentKey.slice('inherit:'.length);
    if (next === undefined) return [{ op: 'remove-inherit', path, name }];
    return [{ op: 'set-inherit', path, name, target: String(next.inherit) }];
  }
  if (next === undefined) {
    const nulled: ComponentAttributes = {};
    for (const attr of Object.keys(ancestor ?? {})) nulled[attr] = null;
    for (const attr of Object.keys(oursVisible ?? {})) nulled[attr] = null;
    return [{ op: 'tombstone-component', path, componentKey, attributes: nulled }];
  }
  const attributes: ComponentAttributes = {};
  for (const attr of Object.keys(ancestor ?? {})) {
    if (!(attr in next)) attributes[attr] = null;
  }
  for (const attr of Object.keys(oursVisible ?? {})) {
    if (!(attr in next)) attributes[attr] = null;
  }
  Object.assign(attributes, next);
  return [{ op: 'set-component', path, componentKey, attributes }];
}
