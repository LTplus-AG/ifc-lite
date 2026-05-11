/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity-level operations on the Y.Doc.
 *
 * Each function maps directly to a row in the spec §6 operations table.
 * Callers are expected to wrap multi-step edits in `ydoc.transact()`.
 */

import * as Y from 'yjs';
import {
  ENTITY_KEY,
  entitiesMap,
  type ClassificationRef,
  type EntityMeta,
  type GeometryRefRecord,
  type MaterialAssignment,
  type PropertyValue,
} from './schema.js';

/** Options for `createEntity`. */
export interface CreateEntityOptions {
  ifcClass?: string;
  schemaVersion?: 'ifc4' | 'ifc4x3' | 'ifc5';
  attributes?: Record<string, unknown>;
  children?: Record<string, string>;
  inherits?: Record<string, string>;
  meta?: EntityMeta;
}

/**
 * Look up the entity Y.Map by path. Returns `undefined` if missing or
 * tombstoned.
 */
export function getEntity(doc: Y.Doc, path: string): Y.Map<unknown> | undefined {
  return entitiesMap(doc).get(path) as Y.Map<unknown> | undefined;
}

/** Existence check that ignores tombstones. */
export function hasEntity(doc: Y.Doc, path: string): boolean {
  return entitiesMap(doc).has(path);
}

/**
 * Build a fresh entity Y.Map shape and register it under `path`.
 *
 * Idempotent: if the entity already exists, this is a no-op (use
 * `setAttribute` etc. for incremental updates). To replace an entity
 * outright, call `deleteEntity` first.
 */
export function createEntity(
  doc: Y.Doc,
  path: string,
  options: CreateEntityOptions = {},
): Y.Map<unknown> {
  const ents = entitiesMap(doc);
  const existing = ents.get(path) as Y.Map<unknown> | undefined;
  if (existing) {
    return existing;
  }

  const entity = new Y.Map<unknown>();

  const attributes = new Y.Map<unknown>();
  if (options.attributes) {
    for (const [k, v] of Object.entries(options.attributes)) {
      attributes.set(k, v);
    }
  }
  entity.set(ENTITY_KEY.ATTRIBUTES, attributes);

  const children = new Y.Map<string>();
  if (options.children) {
    for (const [role, target] of Object.entries(options.children)) {
      children.set(role, target);
    }
  }
  entity.set(ENTITY_KEY.CHILDREN, children);

  const inherits = new Y.Map<string>();
  if (options.inherits) {
    for (const [role, target] of Object.entries(options.inherits)) {
      inherits.set(role, target);
    }
  }
  entity.set(ENTITY_KEY.INHERITS, inherits);

  entity.set(ENTITY_KEY.PSETS, new Y.Map<Y.Map<PropertyValue>>());
  entity.set(ENTITY_KEY.QUANTITIES, new Y.Map<Y.Map<number>>());
  entity.set(ENTITY_KEY.CLASSIFICATIONS, new Y.Array<ClassificationRef>());
  entity.set(ENTITY_KEY.MATERIALS, new Y.Array<MaterialAssignment>());
  entity.set(ENTITY_KEY.GEOMETRY_REF, new Y.Map<unknown>());

  const meta = new Y.Map<unknown>();
  const stamp = options.meta?.createdAt ?? new Date().toISOString();
  if (options.ifcClass) meta.set('ifcClass', options.ifcClass);
  if (options.schemaVersion) meta.set('schemaVersion', options.schemaVersion);
  meta.set('createdAt', stamp);
  if (options.meta) {
    for (const [k, v] of Object.entries(options.meta)) {
      meta.set(k, v as unknown);
    }
  }
  entity.set(ENTITY_KEY.META, meta);

  ents.set(path, entity);
  return entity;
}

/**
 * Delete an entity. Yjs preserves the operation as a tombstone; observers
 * see a `delete` event.
 */
export function deleteEntity(doc: Y.Doc, path: string): boolean {
  const ents = entitiesMap(doc);
  if (!ents.has(path)) return false;
  ents.delete(path);
  return true;
}

/**
 * Type promotion (e.g. IfcWall → IfcCurtainWall). Implemented as
 * delete + create with `meta.previousPath` linking the new entity to the
 * old path so consumers can render history.
 */
export function promoteEntityType(
  doc: Y.Doc,
  oldPath: string,
  newPath: string,
  newIfcClass: string,
  options: { keepAttributes?: boolean } = {},
): Y.Map<unknown> | undefined {
  const old = getEntity(doc, oldPath);
  if (!old) return undefined;

  const oldAttrs = old.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
  const oldChildren = old.get(ENTITY_KEY.CHILDREN) as Y.Map<string> | undefined;
  const oldMeta = old.get(ENTITY_KEY.META) as Y.Map<unknown> | undefined;

  const carried: Record<string, unknown> = {};
  if (options.keepAttributes !== false && oldAttrs) {
    for (const [k, v] of oldAttrs.entries()) carried[k] = v;
  }
  // ifcClass attribute, if any, is overridden.
  carried['bsi::ifc::class'] = { code: newIfcClass };

  const carriedChildren: Record<string, string> = {};
  if (oldChildren) {
    for (const [role, target] of oldChildren.entries()) {
      carriedChildren[role] = target;
    }
  }

  const meta: EntityMeta = {
    ifcClass: newIfcClass,
    previousPath: oldPath,
    createdAt: new Date().toISOString(),
    lastEditedAt: new Date().toISOString(),
  };
  if (oldMeta) {
    const createdBy = oldMeta.get('createdBy');
    if (typeof createdBy === 'string') meta.createdBy = createdBy;
  }

  deleteEntity(doc, oldPath);
  return createEntity(doc, newPath, {
    ifcClass: newIfcClass,
    attributes: carried,
    children: carriedChildren,
    meta,
  });
}

/* ------------------------------------------------------------------ */
/* Attributes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Set a flat namespaced attribute (e.g. `bsi::ifc::class` or
 * `usd::xformOp::translate`). Mirrors IFCX's wire shape.
 */
export function setAttribute(doc: Y.Doc, path: string, name: string, value: unknown): void {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`@ifc-lite/collab: entity "${path}" not found`);
  const attrs = entity.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
  if (!attrs) throw new Error(`@ifc-lite/collab: entity "${path}" missing attributes map`);
  attrs.set(name, value);
}

export function deleteAttribute(doc: Y.Doc, path: string, name: string): boolean {
  const entity = getEntity(doc, path);
  if (!entity) return false;
  const attrs = entity.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
  if (!attrs || !attrs.has(name)) return false;
  attrs.delete(name);
  return true;
}

export function getAttribute(doc: Y.Doc, path: string, name: string): unknown {
  return (getEntity(doc, path)?.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined)?.get(name);
}

/* ------------------------------------------------------------------ */
/* Children / hierarchy                                                */
/* ------------------------------------------------------------------ */

/** Set or update a `role → child path` entry on an entity. */
export function setChild(doc: Y.Doc, path: string, role: string, childPath: string): void {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`@ifc-lite/collab: entity "${path}" not found`);
  const children = entity.get(ENTITY_KEY.CHILDREN) as Y.Map<string> | undefined;
  if (!children) throw new Error(`@ifc-lite/collab: entity "${path}" missing children map`);
  children.set(role, childPath);
}

export function removeChild(doc: Y.Doc, path: string, role: string): boolean {
  const entity = getEntity(doc, path);
  if (!entity) return false;
  const children = entity.get(ENTITY_KEY.CHILDREN) as Y.Map<string> | undefined;
  if (!children || !children.has(role)) return false;
  children.delete(role);
  return true;
}

/** Move an entity's containment by updating both endpoints atomically. */
export function moveEntity(
  doc: Y.Doc,
  childPath: string,
  fromParentPath: string,
  toParentPath: string,
  role: string,
): void {
  doc.transact(() => {
    removeChild(doc, fromParentPath, role);
    setChild(doc, toParentPath, role, childPath);
  });
}

/* ------------------------------------------------------------------ */
/* Property sets                                                        */
/* ------------------------------------------------------------------ */

/** Set a property within a Pset; creates the Pset map if missing. */
export function setPropertyValue(
  doc: Y.Doc,
  path: string,
  psetName: string,
  propName: string,
  value: PropertyValue,
): void {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`@ifc-lite/collab: entity "${path}" not found`);
  const psets = entity.get(ENTITY_KEY.PSETS) as Y.Map<Y.Map<PropertyValue>> | undefined;
  if (!psets) throw new Error(`@ifc-lite/collab: entity "${path}" missing psets map`);

  let pset = psets.get(psetName);
  if (!pset) {
    pset = new Y.Map<PropertyValue>();
    psets.set(psetName, pset);
  }
  pset.set(propName, value);
}

export function deletePropertyValue(
  doc: Y.Doc,
  path: string,
  psetName: string,
  propName: string,
): boolean {
  const psets = getEntity(doc, path)?.get(ENTITY_KEY.PSETS) as
    | Y.Map<Y.Map<PropertyValue>>
    | undefined;
  const pset = psets?.get(psetName);
  if (!pset || !pset.has(propName)) return false;
  pset.delete(propName);
  // Clean up empty psets.
  if (pset.size === 0) psets!.delete(psetName);
  return true;
}

export function getPropertyValue(
  doc: Y.Doc,
  path: string,
  psetName: string,
  propName: string,
): PropertyValue | undefined {
  const psets = getEntity(doc, path)?.get(ENTITY_KEY.PSETS) as
    | Y.Map<Y.Map<PropertyValue>>
    | undefined;
  return psets?.get(psetName)?.get(propName);
}

/* ------------------------------------------------------------------ */
/* Quantities                                                           */
/* ------------------------------------------------------------------ */

export function setQuantityValue(
  doc: Y.Doc,
  path: string,
  qsetName: string,
  qtyName: string,
  value: number,
): void {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`@ifc-lite/collab: entity "${path}" not found`);
  const qsets = entity.get(ENTITY_KEY.QUANTITIES) as Y.Map<Y.Map<number>> | undefined;
  if (!qsets) throw new Error(`@ifc-lite/collab: entity "${path}" missing quantities map`);
  let qset = qsets.get(qsetName);
  if (!qset) {
    qset = new Y.Map<number>();
    qsets.set(qsetName, qset);
  }
  qset.set(qtyName, value);
}

/* ------------------------------------------------------------------ */
/* Classifications & materials                                          */
/* ------------------------------------------------------------------ */

export function addClassification(doc: Y.Doc, path: string, ref: ClassificationRef): number {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`@ifc-lite/collab: entity "${path}" not found`);
  const arr = entity.get(ENTITY_KEY.CLASSIFICATIONS) as Y.Array<ClassificationRef> | undefined;
  if (!arr) throw new Error(`@ifc-lite/collab: entity "${path}" missing classifications`);
  arr.push([ref]);
  return arr.length - 1;
}

export function addMaterial(doc: Y.Doc, path: string, assignment: MaterialAssignment): number {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`@ifc-lite/collab: entity "${path}" not found`);
  const arr = entity.get(ENTITY_KEY.MATERIALS) as Y.Array<MaterialAssignment> | undefined;
  if (!arr) throw new Error(`@ifc-lite/collab: entity "${path}" missing materials`);
  arr.push([assignment]);
  return arr.length - 1;
}

/* ------------------------------------------------------------------ */
/* Geometry reference                                                   */
/* ------------------------------------------------------------------ */

/** Point an entity at a specific entry in the top-level geometry map. */
export function setGeometryRef(doc: Y.Doc, path: string, ref: GeometryRefRecord): void {
  const entity = getEntity(doc, path);
  if (!entity) throw new Error(`@ifc-lite/collab: entity "${path}" not found`);
  const refMap = entity.get(ENTITY_KEY.GEOMETRY_REF) as Y.Map<unknown> | undefined;
  if (!refMap) throw new Error(`@ifc-lite/collab: entity "${path}" missing geometryRef`);
  refMap.set('geomId', ref.geomId);
}

export function getGeometryRef(doc: Y.Doc, path: string): GeometryRefRecord | undefined {
  const refMap = getEntity(doc, path)?.get(ENTITY_KEY.GEOMETRY_REF) as
    | Y.Map<unknown>
    | undefined;
  const geomId = refMap?.get('geomId');
  return typeof geomId === 'string' ? { geomId } : undefined;
}

/* ------------------------------------------------------------------ */
/* Iteration helpers                                                    */
/* ------------------------------------------------------------------ */

/** Iterate every (path, entity) pair currently live. */
export function* iterEntities(
  doc: Y.Doc,
): IterableIterator<[string, Y.Map<unknown>]> {
  const ents = entitiesMap(doc);
  for (const [path, entity] of ents.entries()) {
    yield [path, entity];
  }
}

/**
 * Convert an entity Y.Map into a plain JSON snapshot. Useful for tests and
 * for the IFCX writer.
 */
export function entityToJSON(entity: Y.Map<unknown>): {
  attributes: Record<string, unknown>;
  children: Record<string, string>;
  inherits: Record<string, string>;
  psets: Record<string, Record<string, PropertyValue>>;
  classifications: ClassificationRef[];
  materials: MaterialAssignment[];
  geometryRef?: string;
  meta: Record<string, unknown>;
} {
  const attrs = entity.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
  const children = entity.get(ENTITY_KEY.CHILDREN) as Y.Map<string> | undefined;
  const inherits = entity.get(ENTITY_KEY.INHERITS) as Y.Map<string> | undefined;
  const psets = entity.get(ENTITY_KEY.PSETS) as Y.Map<Y.Map<PropertyValue>> | undefined;
  const classifications = entity.get(ENTITY_KEY.CLASSIFICATIONS) as
    | Y.Array<ClassificationRef>
    | undefined;
  const materials = entity.get(ENTITY_KEY.MATERIALS) as Y.Array<MaterialAssignment> | undefined;
  const geomRef = entity.get(ENTITY_KEY.GEOMETRY_REF) as Y.Map<unknown> | undefined;
  const meta = entity.get(ENTITY_KEY.META) as Y.Map<unknown> | undefined;

  const attributes: Record<string, unknown> = {};
  if (attrs) for (const [k, v] of attrs.entries()) attributes[k] = v;

  const childrenJson: Record<string, string> = {};
  if (children) for (const [k, v] of children.entries()) childrenJson[k] = v;

  const inheritsJson: Record<string, string> = {};
  if (inherits) for (const [k, v] of inherits.entries()) inheritsJson[k] = v;

  const psetsJson: Record<string, Record<string, PropertyValue>> = {};
  if (psets) {
    for (const [psetName, pset] of psets.entries()) {
      const props: Record<string, PropertyValue> = {};
      for (const [propName, val] of pset.entries()) {
        props[propName] = val;
      }
      psetsJson[psetName] = props;
    }
  }

  const metaJson: Record<string, unknown> = {};
  if (meta) for (const [k, v] of meta.entries()) metaJson[k] = v;

  const geomId = geomRef?.get('geomId');

  return {
    attributes,
    children: childrenJson,
    inherits: inheritsJson,
    psets: psetsJson,
    classifications: classifications ? classifications.toArray() : [],
    materials: materials ? materials.toArray() : [],
    geometryRef: typeof geomId === 'string' ? geomId : undefined,
    meta: metaJson,
  };
}
