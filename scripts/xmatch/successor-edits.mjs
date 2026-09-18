/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mapped-item and property-value edits for issue #4955: `swapped` repoints
 * the one body `IfcMappedItem` an element owns, `respecified` changes one
 * property value the element owns. Split out of `edits.mjs` for size; the
 * locality rules are the same as there.
 */

import { isExclusivelyOwnedBy, isLive, refAt, structuralRefCount, PRODUCT_REPRESENTATION } from './edits.mjs';
import { quote, real, referencesIn, rewriteReferences, setArg, splitArgs, unquote } from './step-file.mjs';

/** `IfcMappedItem` slots: (MappingSource, MappingTarget). */
const MAPPED_SOURCE = 0;
/** `IfcShapeRepresentation` slots: (ContextOfItems, RepresentationIdentifier, RepresentationType, Items). */
const REPRESENTATION_IDENTIFIER = 1;
const REPRESENTATION_ITEMS = 3;
/** `IfcRepresentationMap` slots: (MappingOrigin, MappedRepresentation). */
const MAP_REPRESENTATION = 1;

/** Is this shape representation the meshed one? */
function isBodyRepresentation(statement) {
  return (
    statement?.type === 'IFCSHAPEREPRESENTATION' &&
    unquote(splitArgs(statement.args)[REPRESENTATION_IDENTIFIER] ?? '$') === 'Body'
  );
}

/**
 * The `IfcMappedItem`s directly under a product's BODY representations,
 * as `{ itemId, mapId }` rows. Only the body: a `FootPrint` or `Axis`
 * representation may carry a mapped item too, and pointing THAT at a
 * different map changes the file and nothing about the mesh — the same trap
 * the retriangulation mutation documents for arcs.
 */
function bodyMappedItems(index, productId) {
  const product = index.byId.get(productId);
  const shapeId = product === undefined ? undefined : refAt(product, PRODUCT_REPRESENTATION);
  if (shapeId === undefined) return [];
  const shape = index.byId.get(shapeId);
  if (shape?.type !== 'IFCPRODUCTDEFINITIONSHAPE') return [];
  const rows = [];
  for (const representationId of referencesIn(splitArgs(shape.args)[2] ?? '')) {
    const representation = index.byId.get(representationId);
    if (!isBodyRepresentation(representation)) continue;
    for (const itemId of referencesIn(splitArgs(representation.args)[REPRESENTATION_ITEMS] ?? '')) {
      const item = index.byId.get(itemId);
      if (item?.type !== 'IFCMAPPEDITEM') continue;
      const mapId = refAt(item, MAPPED_SOURCE);
      if (mapId !== undefined) rows.push({ itemId, mapId });
    }
  }
  return rows;
}

/**
 * The one `IfcMappedItem` this element's body owns outright, and the
 * `IfcRepresentationMap` it points at; undefined when the body is not a
 * single owned mapped item.
 *
 * Ownership is of the MAPPED ITEM, not of the map: the map is type geometry
 * shared by every occurrence and is never written. What `swapMappedItem`
 * rewrites is the one pointer from this occurrence's own item to a map.
 */
export function ownedMappedItem(index, productId) {
  const product = index.byId.get(productId);
  const shapeId = product === undefined ? undefined : refAt(product, PRODUCT_REPRESENTATION);
  if (shapeId === undefined || structuralRefCount(index, shapeId) !== 1) return undefined;
  const items = bodyMappedItems(index, productId);
  if (items.length !== 1) return undefined;
  const { itemId, mapId } = items[0];
  if (!isExclusivelyOwnedBy(index, itemId, productId)) return undefined;
  const map = index.byId.get(mapId);
  if (map?.type !== 'IFCREPRESENTATIONMAP') return undefined;
  if (!isBodyRepresentation(index.byId.get(refAt(map, MAP_REPRESENTATION)))) return undefined;
  return { itemId, mapId };
}

/** Every body `IfcRepresentationMap` a product reaches. */
export function representationMapsOf(index, productId) {
  return bodyMappedItems(index, productId).map((row) => row.mapId);
}

/**
 * A structural digest of everything under a representation map: entity types
 * and literal arguments in depth-first order, with references replaced by
 * their visit order. Two maps that are byte-for-byte copies of one geometry
 * — ArchiCAD writes one `IfcRepresentationMap` per window and several of
 * them identical — digest equal, and a `swapped` element pointed at such a
 * copy would keep its world geometry hash and be paired as `respecified`,
 * which the key would then call wrong. The digest is the base-side fact that
 * rules those donors out; no hash of the head is consulted.
 */
export function representationMapDigest(index, mapId) {
  // An explicit stack, not recursion: the walk follows references the FILE
  // supplies, and a deep or cyclic subgraph must not be able to blow the
  // call stack. `order` is the visited set, so every id is expanded once
  // and the walk is bounded by the number of statements.
  const order = new Map();
  const lines = [];
  const stack = [{ id: mapId, expanded: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const statement = index.byId.get(frame.id);
    if (!frame.expanded) {
      if (order.has(frame.id)) {
        stack.pop();
        continue;
      }
      order.set(frame.id, order.size);
      frame.expanded = true;
      if (!statement) {
        stack.pop();
        continue;
      }
      // Pushed in reverse so the children are expanded in file order, which
      // is what the recursive walk did and what keeps the digest stable.
      const children = referencesIn(statement.args);
      for (let i = children.length - 1; i >= 0; i--) {
        if (!order.has(children[i])) stack.push({ id: children[i], expanded: false });
      }
      continue;
    }
    stack.pop();
    const children = referencesIn(statement.args);
    const map = new Map(children.map((child) => [child, order.get(child) ?? -1]));
    lines.push(`${statement.type}(${rewriteReferences(statement.args, map)})`);
  }
  return lines.join('\n');
}

/** Point the element's owned mapped item at `donorMapId`. */
export function swapMappedItem(index, productId, donorMapId) {
  const owned = ownedMappedItem(index, productId);
  if (!owned || owned.mapId === donorMapId) return false;
  const item = index.byId.get(owned.itemId);
  item.args = setArg(item, MAPPED_SOURCE, `#${donorMapId}`).args;
  return true;
}

/**
 * The property-set values this element owns outright: each is an
 * `IfcPropertySingleValue` reachable through an `IfcRelDefinesByProperties`
 * that relates THIS element alone, a set nothing else references, and a
 * property nothing else references. IFC shares property sets and even single
 * properties across occurrences, and editing a shared one would respecify
 * elements the key calls untouched.
 *
 * Returns `{ propertyId, name }` rows, in file order.
 */
export function ownedPropertyValues(index, productId) {
  const rows = [];
  for (const entry of index.refs.get(productId) ?? []) {
    const rel = entry.statement;
    if (rel.type !== 'IFCRELDEFINESBYPROPERTIES' || !isLive(index, rel)) continue;
    const parts = splitArgs(rel.args);
    // (GlobalId, OwnerHistory, Name, Description, RelatedObjects, RelatingPropertyDefinition)
    const related = referencesIn(parts[4] ?? '');
    if (related.length !== 1 || related[0] !== productId) continue;
    const setId = refAt(rel, 5);
    const set = setId === undefined ? undefined : index.byId.get(setId);
    if (set?.type !== 'IFCPROPERTYSET' || structuralRefCount(index, setId) !== 1) continue;
    // (GlobalId, OwnerHistory, Name, Description, HasProperties)
    for (const propertyId of referencesIn(splitArgs(set.args)[4] ?? '')) {
      const property = index.byId.get(propertyId);
      if (property?.type !== 'IFCPROPERTYSINGLEVALUE') continue;
      if (structuralRefCount(index, propertyId) !== 1) continue;
      const value = splitArgs(property.args)[2];
      // A typed literal only — `IFCLABEL('x')`, `IFCREAL(1.)`, `IFCBOOLEAN(.T.)`.
      // Editing an enumeration or a reference would be a schema question.
      if (!/^(IFC[A-Z]+)\((.+)\)$/s.test(value ?? '')) continue;
      rows.push({ propertyId, name: unquote(splitArgs(property.args)[0] ?? '$') });
    }
  }
  return rows;
}

/**
 * Change ONE owned property value, keeping its type and its name. A label
 * gets a suffix, a number is scaled, a logical is flipped — the property NAME
 * multiset the harness asserts identical between revisions is untouched.
 */
export function respecifyProperty(index, propertyId) {
  const property = index.byId.get(propertyId);
  const parts = splitArgs(property.args);
  const typed = /^(IFC[A-Z]+)\((.+)\)$/s.exec(parts[2]);
  if (!typed) return false;
  const [, type, literal] = typed;
  let next;
  if (/^'.*'$/s.test(literal)) next = quote(`${unquote(literal)} (rev B)`);
  else if (/^\.(T|F)\.$/.test(literal)) next = literal === '.T.' ? '.F.' : '.T.';
  else if (/^-?\d+\.?\d*(E[-+]?\d+)?$/i.test(literal)) {
    const number = Number.parseFloat(literal);
    if (!Number.isFinite(number)) return false;
    const scaled = number === 0 ? 1 : number * 1.5;
    next = /[.E]/i.test(literal) ? real(scaled) : String(Math.round(scaled));
  } else return false;
  parts[2] = `${type}(${next})`;
  property.args = parts.join(',');
  return true;
}
