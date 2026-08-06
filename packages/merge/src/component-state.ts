/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Component-state extraction: the "semantic reading" of a layer stack.
 *
 * Flattens an ordered stack of IFCX documents (weakest first, later wins)
 * into per-entity component states keyed by the shared componentKey
 * vocabulary. Unlike the viewer composition path, tombstones are kept
 * visible here (`deleted` flag) — the merge matrix needs to see them.
 */

import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { ATTR, IFCLITE_ATTR, canonicalStringify, isTypedPropertyValue, parseV5aKey } from '@ifc-lite/ifcx';
import { stableHash } from '@ifc-lite/diff';
import type { ComponentAttributes, ComponentKey, ComponentSnapshot } from './types.js';

export interface EntityState {
  path: string;
  /** Component values by key, hashes computed lazily via `snapshotOf`. */
  components: Map<ComponentKey, ComponentAttributes>;
  /** Child slots: role name → child path. */
  children: Map<string, string>;
  /** Inheritance slots: role name → inherited path. */
  inherits: Map<string, string>;
  /**
   * Final tombstone state for the path — explicit `ifclite::deleted`
   * opinions plus subtree shadowing (a tombstoned parent deletes its
   * descendants, exactly as composition does).
   */
  deleted: boolean;
  /**
   * True only when the strongest `ifclite::deleted` opinion on THIS path
   * is a tombstone. Shadow deaths (a deleted ancestor) leave it false —
   * the matrix must not emit its own delete op for those: the parent's
   * tombstone already shadows the subtree at composition time, and the
   * parent may itself be in conflict.
   */
  explicitDeleted: boolean;
}

export type StackState = Map<string, EntityState>;

/** `Qto_*` set names always route to quantities (same rule as `@ifc-lite/collab`'s inflation). */
const QTO_SET_RE = /^Qto_/;
/** Numbers under `Pset_*` sets stay flat/legacy rather than quantities — mirrors the collab rule. */
const PSET_SET_RE = /^Pset_/;
/**
 * The original name-anywhere patterns, kept for NON-v5a keys so this
 * change stays strictly additive. Only the `bsi::ifc::v5a::` branch above
 * gains new behaviour.
 */
const PSET_ANYWHERE_RE = /(?:^|::)(Pset_[A-Za-z0-9_]+)(?:::|$)/;
const QSET_ANYWHERE_RE = /(?:^|::)(Qto_[A-Za-z0-9_]+)(?:::|$)/;

/**
 * Map an IFCX attribute key (+ its value, when known) onto the layer-op
 * componentKey vocabulary. Diff keys and op keys are deliberately the
 * same words (02 §2.2).
 *
 * `bsi::ifc::v5a::<Set>::<Member>` keys carry an author-chosen set name
 * that is NOT required to start with `Pset_`/`Qto_` — `changeSetToOps`
 * builds `pset:<name>`/`qset:<name>` unconditionally from the mutation
 * type, for any name, and `@ifc-lite/collab`'s structured-attribute
 * inflation already disambiguates custom set names by VALUE SHAPE
 * (typed-record → pset, plain finite number → quantity) rather than by
 * matching the set name against those two prefixes. This used a
 * name-only regex instead, so any pset/qset whose author-chosen name
 * didn't start with `Pset_`/`Qto_` silently fell through to a
 * one-off-per-attribute `attr:<key>` bucket instead of `pset:<name>` /
 * `qset:<name>` — e.g. a whole-pset tombstone
 * (`buildDeltaNodes`'s `tombstone-component` case) looks up the base
 * state's members by `pset:<name>`, found nothing under that bucket,
 * and nulled zero attributes: a "delete this property set" edit on a
 * custom-named set silently did nothing.
 *
 * A `null` value (an in-flight member deletion, not a whole-component
 * tombstone) carries no shape to disambiguate from, so it keeps the
 * old literal-prefix-only classification — the same shape this
 * function has always had for that case, no behavior change there.
 */
export function componentKeyForAttribute(attribute: string, value?: unknown): ComponentKey {
  if (attribute === ATTR.CLASS) return 'attr:class';
  if (attribute === ATTR.TRANSFORM) return 'placement';
  const v5a = parseV5aKey(attribute);
  if (v5a) {
    const { setName } = v5a;
    if (value !== null && value !== undefined) {
      if (QTO_SET_RE.test(setName)) {
        const candidate = isTypedPropertyValue(value) ? value.value : value;
        if (typeof candidate === 'number' && Number.isFinite(candidate)) return `qset:${setName}`;
      }
      if (isTypedPropertyValue(value)) return `pset:${setName}`;
      if (typeof value === 'number' && Number.isFinite(value) && !PSET_SET_RE.test(setName)) {
        return `qset:${setName}`;
      }
    }
    // No value (or a `null` deletion) to disambiguate a custom set name by
    // shape: fall back to the literal-prefix convention.
    if (PSET_SET_RE.test(setName)) return `pset:${setName}`;
    if (QTO_SET_RE.test(setName)) return `qset:${setName}`;
  }
  // Non-v5a keys keep the original name-anywhere classification verbatim.
  // The v5a branch above is the only behaviour this function changes; the
  // shapes below (a bare `Pset_X::Y`, or a `Pset_`-named member under
  // `bsi::ifc::prop::`) are not what the custom-set bug is about, and
  // silently rebucketing them would move members between components in a
  // merge that never asked for it.
  const pset = PSET_ANYWHERE_RE.exec(attribute);
  if (pset) return `pset:${pset[1]}`;
  const qset = QSET_ANYWHERE_RE.exec(attribute);
  if (qset) return `qset:${qset[1]}`;
  if (attribute.startsWith(ATTR.PROP_PREFIX)) {
    return `attr:prop:${attribute.slice(ATTR.PROP_PREFIX.length)}`;
  }
  if (attribute.startsWith('usd::')) {
    const tier = attribute.split('::').pop() ?? 'usd';
    return `geometry:${tier}`;
  }
  return `attr:${attribute}`;
}

/**
 * Flatten an ordered stack (weakest first) into entity component states.
 * Later opinions shadow earlier ones per attribute; `null` child values
 * remove slots; `ifclite::deleted` resolves to the strongest opinion.
 */
export function extractStackState(layers: readonly IfcxFile[]): StackState {
  const state: StackState = new Map();

  const entityFor = (path: string): EntityState => {
    let entity = state.get(path);
    if (!entity) {
      entity = {
        path,
        components: new Map(),
        children: new Map(),
        inherits: new Map(),
        deleted: false,
        explicitDeleted: false,
      };
      state.set(path, entity);
    }
    return entity;
  };

  for (const layer of layers) {
    for (const node of layer.data) {
      applyNode(entityFor(node.path), node);
    }
  }

  // Drop empty shells created purely by child references.
  for (const [path, entity] of state) {
    if (
      entity.components.size === 0 &&
      entity.children.size === 0 &&
      entity.inherits.size === 0 &&
      !entity.deleted
    ) {
      state.delete(path);
    }
  }

  // Entity tombstones shadow child paths: composition removes the whole
  // subtree, so the merge state must see descendants as deleted too —
  // otherwise a candidate deleting a parent while the target edits a
  // descendant would silently miss the delete-vs-modify conflict.
  const queue: string[] = [];
  for (const entity of state.values()) {
    if (entity.deleted) queue.push(entity.path);
  }
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined) break;
    const entity = state.get(path);
    if (!entity) continue;
    for (const childPath of entity.children.values()) {
      const child = state.get(childPath);
      if (child && !child.deleted) {
        child.deleted = true;
        queue.push(childPath);
      }
    }
  }

  return state;
}

function applyNode(entity: EntityState, node: IfcxNode): void {
  if (node.children) {
    for (const [name, child] of Object.entries(node.children)) {
      if (child === null) entity.children.delete(name);
      else entity.children.set(name, child);
    }
  }
  if (node.inherits) {
    for (const [role, target] of Object.entries(node.inherits)) {
      if (target === null) entity.inherits.delete(role);
      else entity.inherits.set(role, target);
    }
  }
  if (!node.attributes) return;
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key === IFCLITE_ATTR.DELETED) {
      entity.deleted = value === true;
      entity.explicitDeleted = value === true;
      continue;
    }
    if (key.startsWith(IFCLITE_ATTR.DERIVED)) continue;
    const componentKey = componentKeyForAttribute(key, value);
    const component = entity.components.get(componentKey) ?? {};
    if (value === null) {
      delete component[key];
      if (Object.keys(component).length === 0) {
        entity.components.delete(componentKey);
        continue;
      }
    } else {
      component[key] = value;
    }
    entity.components.set(componentKey, component);
  }
}

// ---------------------------------------------------------------------------
// Prefix projection (the 05 §5.7 fast path)
// ---------------------------------------------------------------------------

export interface ProjectedStates {
  a: StackState;
  o: StackState;
  t: StackState;
}

/**
 * Project the three stack states onto the paths actually touched by the
 * ours/theirs suffixes — when `ours` and `theirs` share `ancestor` as a
 * prefix, every other path is byte-identical across all three states and
 * contributes nothing to the merge matrix. Untouched entities/components
 * keep the SAME object references on every side, so the matrix can skip
 * hashing them entirely.
 *
 * Returns null — caller must use full extraction — whenever any layer
 * carries an `ifclite::deleted` opinion: tombstones shadow whole subtrees
 * through the children graph, and that propagation is global, not
 * per-path. Restricting the fast path to tombstone-free stacks keeps it
 * provably equivalent to `extractStackState` (see the differential fuzz).
 */
export function projectStackStates(
  ancestor: readonly IfcxFile[],
  oursSuffix: readonly IfcxFile[],
  theirsSuffix: readonly IfcxFile[]
): ProjectedStates | null {
  const touched = new Set<string>();
  for (const suffix of [oursSuffix, theirsSuffix]) {
    for (const layer of suffix) {
      for (const node of layer.data) {
        if (node.attributes?.[IFCLITE_ATTR.DELETED] !== undefined) return null;
        touched.add(node.path);
      }
    }
  }

  // Restricted ancestor fold: only touched paths get materialized. The
  // tombstone scan rides the same pass so a delete-bearing history aborts
  // before any per-side work.
  const a: StackState = new Map();
  for (const layer of ancestor) {
    for (const node of layer.data) {
      if (node.attributes?.[IFCLITE_ATTR.DELETED] !== undefined) return null;
      if (!touched.has(node.path)) continue;
      applyNode(entityFor(a, node.path), node);
    }
  }
  dropEmptyShells(a);

  return {
    a,
    o: projectSide(a, oursSuffix),
    t: projectSide(a, theirsSuffix),
  };
}

/** Clone-on-write side state: ancestor refs shared until a suffix node hits the path. */
function projectSide(a: StackState, suffix: readonly IfcxFile[]): StackState {
  const state: StackState = new Map(a);
  const cloned = new Set<string>();
  for (const layer of suffix) {
    for (const node of layer.data) {
      let entity = state.get(node.path);
      if (entity && !cloned.has(node.path)) {
        entity = {
          path: entity.path,
          components: new Map(entity.components),
          children: new Map(entity.children),
          inherits: new Map(entity.inherits),
          deleted: entity.deleted,
          explicitDeleted: entity.explicitDeleted,
        };
        state.set(node.path, entity);
      } else if (!entity) {
        entity = entityFor(state, node.path);
      }
      cloned.add(node.path);
      applyNodeCow(entity, node);
    }
  }
  // Shell equivalence: a suffix that nulls every attribute away leaves an
  // entity the reference extraction would drop — drop it here too. Only
  // cloned entities can have changed, so only they need the check.
  for (const path of cloned) {
    const entity = state.get(path);
    if (entity && isEmptyShell(entity)) state.delete(path);
  }
  return state;
}

function entityFor(state: StackState, path: string): EntityState {
  let entity = state.get(path);
  if (!entity) {
    entity = {
      path,
      components: new Map(),
      children: new Map(),
      inherits: new Map(),
      deleted: false,
      explicitDeleted: false,
    };
    state.set(path, entity);
  }
  return entity;
}

function isEmptyShell(entity: EntityState): boolean {
  return (
    entity.components.size === 0 &&
    entity.children.size === 0 &&
    entity.inherits.size === 0 &&
    !entity.deleted
  );
}

function dropEmptyShells(state: StackState): void {
  for (const [path, entity] of state) {
    if (isEmptyShell(entity)) state.delete(path);
  }
}

/**
 * `applyNode` for cloned side entities: component objects are copied
 * before mutation so ancestor-shared references are never written through
 * — reference equality stays a valid "unchanged" signal in the matrix.
 */
function applyNodeCow(entity: EntityState, node: IfcxNode): void {
  if (node.children) {
    for (const [name, child] of Object.entries(node.children)) {
      if (child === null) entity.children.delete(name);
      else entity.children.set(name, child);
    }
  }
  if (node.inherits) {
    for (const [role, target] of Object.entries(node.inherits)) {
      if (target === null) entity.inherits.delete(role);
      else entity.inherits.set(role, target);
    }
  }
  if (!node.attributes) return;
  for (const [key, value] of Object.entries(node.attributes)) {
    if (key.startsWith(IFCLITE_ATTR.DERIVED)) continue;
    const componentKey = componentKeyForAttribute(key, value);
    const component: ComponentAttributes = { ...(entity.components.get(componentKey) ?? {}) };
    if (value === null) {
      delete component[key];
      if (Object.keys(component).length === 0) {
        entity.components.delete(componentKey);
        continue;
      }
    } else {
      component[key] = value;
    }
    entity.components.set(componentKey, component);
  }
}

/** Hash + value snapshot for conflict records and fold detection. */
export function snapshotOf(attributes: ComponentAttributes): ComponentSnapshot {
  return { hash: stableHash(canonicalStringify(attributes)), attributes };
}

/**
 * Unified view used by the matrix: real components plus `child:<name>` /
 * `inherit:<role>` pseudo-components whose single attribute is the
 * referenced path. Both are relation edges, so divergent edits surface
 * as `hierarchy` conflicts.
 */
export function componentEntries(entity: EntityState): Map<ComponentKey, ComponentAttributes> {
  const entries = new Map<ComponentKey, ComponentAttributes>(entity.components);
  for (const [name, child] of entity.children) {
    entries.set(`child:${name}`, { child });
  }
  for (const [role, target] of entity.inherits) {
    entries.set(`inherit:${role}`, { inherit: target });
  }
  return entries;
}
