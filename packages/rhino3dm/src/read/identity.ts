/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isValidIfcGuid, isValidUuid, uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import type { RhinoUserStrings } from '../types.js';
import type { IfcClasses } from './ifc-classes.js';
import { plural, type Report } from './report.js';
import type { RhinoImportEntity, RhinoImportPropertySet, RhinoImportVisibility } from './types.js';

export const FALLBACK_CLASS = 'IfcBuildingElementProxy';
/** Namespace for the GlobalId of an object whose own UUID cannot supply one. */
const FALLBACK_NAMESPACE = '6f1e2b0a-7c1d-4f7e-9d59-3c0f4a1d2b77';
/** `IFC::*` keys that fill entity columns instead of the `IFC` property set. */
const COLUMN_KEYS = new Set(['description', 'objecttype']);

/** What identity needs to know about one drawn top-level object. */
export interface ObjectFacts extends RhinoImportVisibility {
  id: string; name: string; type: string; layer: number; layerPath: string;
  groups: number[]; userStrings: RhinoUserStrings; material: string;
}

/** Split a key at its first `::`. The reserved sets `IFC` and `Rhino` are matched by `reserved`: the set trimmed, case ignored. */
function splitKey(key: string): { set: string; reserved: string; name: string } | null {
  const at = key.indexOf('::'), set = key.slice(0, at), name = key.slice(at + 2);
  return at > 0 && name ? { set, reserved: set.trim().toLowerCase(), name } : null;
}

/**
 * Look up `IFC::<name>`, with the rule that sorts keys into property sets, so
 * a key routed to the `IFC` set is the one read here. openNURBS keys ignore
 * case, so `ifc::globalid` is `IFC::GlobalId`.
 */
export function ifcString(strings: RhinoUserStrings, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return strings.find(([key]) => { const split = splitKey(key); return split?.reserved === 'ifc' && split.name.toLowerCase() === wanted; })?.[1];
}

/**
 * The value an entity column takes: the first part that states `IFC::<name>` with a value, else `''`.
 * Read from the parts, so the rule holds however `mergeUserText` numbers a later part's value, and an
 * empty value counts as unset, so the column never depends on what a .3dm can hold.
 */
function columnString(parts: ObjectFacts[], name: string): string {
  for (const part of parts) { const value = ifcString(part.userStrings, name); if (value) return value; }
  return '';
}

/**
 * Sort Attribute User Text into property sets. A key splits at its first `::`
 * into set and property, as the exporter wrote it; a key without one goes to
 * `Attribute User Text`, and so does a `Rhino::` key, because the `Rhino` set
 * holds only what the reader derives. Values stay strings: user text has no types.
 */
function propertySets(o: ObjectFacts, userStrings: RhinoUserStrings): RhinoImportPropertySet[] {
  const sets = new Map<string, [string, string][]>();
  const put = (set: string, name: string, value: string) => {
    const properties = sets.get(set);
    if (properties) properties.push([name, value]); else sets.set(set, [[name, value]]);
  };
  // The first occurrence of each column key is consumed whether or not it has a value, so a second
  // spelling of it stays a property, and an empty one is dropped while a later part fills the column.
  const columns = new Set<string>();
  for (const [key, value] of userStrings) {
    const split = splitKey(key), column = split?.name.toLowerCase() ?? '';
    if (!split || split.reserved === 'rhino') put('Attribute User Text', key, value);
    else if (split.reserved !== 'ifc') put(split.set, split.name, value);
    else if (COLUMN_KEYS.has(column) && !columns.has(column)) columns.add(column);
    else put('IFC', split.name, value);
  }
  put('Rhino', 'Layer', o.layerPath);
  put('Rhino', 'ObjectType', o.type);
  put('Rhino', 'ObjectId', o.id);
  if (o.material) put('Rhino', 'Material', o.material);
  return Array.from(sets, ([name, properties]) => ({ name, properties }));
}

/** A key as it is compared: case ignored, and a reserved set name trimmed, so `IFC ::Name` is `IFC::Name`. */
function comparable(key: string): string {
  const split = splitKey(key);
  return (split && (split.reserved === 'ifc' || split.reserved === 'rhino') ? `${split.reserved}::${split.name}` : key).toLowerCase();
}

/**
 * The user text of a merged entity: the first part's, verbatim, then what each
 * later part adds, in file order. Keys are compared as `comparable` does, and
 * only an equal key with an equal value is a repeat that is dropped; a literal
 * `<key> #2` is a key of its own. A later part's key the entity does not hold
 * is appended as written. A held key with a new value is appended as
 * `<key> #<n>`, `n` counting up from 2 per key and skipping every name that
 * any part of the entity states, so a generated name never takes a stated one.
 * So every value stays, and the first part's is the one read as identity.
 */
function mergeUserText(parts: ObjectFacts[]): RhinoUserStrings {
  const merged: RhinoUserStrings = [], taken = new Set<string>();
  for (const part of parts) for (const [key] of part.userStrings) taken.add(comparable(key));
  const held = new Map<string, { values: Set<string>; next: number }>();
  parts.forEach((part, index) => {
    for (const [key, value] of part.userStrings) {
      const id = comparable(key);
      let name = key, entry = held.get(id);
      if (!entry) held.set(id, entry = { values: new Set(), next: 2 });
      else if (index > 0) {
        if (entry.values.has(value)) continue;
        do name = `${key} #${entry.next++}`; while (taken.has(comparable(name)));
        taken.add(comparable(name));
      }
      entry.values.add(value);
      merged.push([name, value]);
    }
  });
  return merged;
}

/**
 * Turn drawn objects into entities, in file order.
 *
 * Objects that share a valid `IFC::GlobalId` merge into one entity only when
 * they also sit in a Rhino group named that GlobalId, which is how the exporter
 * writes a multi-part element. Any other repeat (a copy-paste keeps user text)
 * stays its own entity under an id derived from its Rhino UUID.
 */
export function buildEntities(objects: ObjectFacts[], groupNames: string[], classes: IfcClasses, report: Report): { entities: RhinoImportEntity[]; entityOf: number[] } {
  const stated = objects.map(o => {
    const id = ifcString(o.userStrings, 'GlobalId');
    return id !== undefined && isValidIfcGuid(id) ? id : null;
  });
  const grouped = objects.map((o, i) => stated[i] !== null && o.groups.some(g => groupNames[g] === stated[i]));
  // Every stated id is reserved, so no derived id can take one that a later object states.
  const reserved = new Set(stated.filter(id => id !== null));
  const groupOwned = new Set(stated.filter((_, i) => grouped[i]));
  const used = new Set<string>(), groupEntity = new Map<string, number>();
  const derive = (o: ObjectFacts, index: number): string => {
    for (let attempt = 0; ; attempt++) {
      const uuid = attempt === 0 && isValidUuid(o.id) ? o.id : uuidV5(FALLBACK_NAMESPACE, `${o.id}#${index}#${attempt}`);
      const id = uuidToIfcGuid(uuid);
      if (!reserved.has(id) && !used.has(id)) return id;
    }
  };
  const drafts: { globalId: string; parts: ObjectFacts[] }[] = [], entityOf: number[] = [];
  objects.forEach((o, i) => {
    const id = stated[i];
    const merged = id !== null && grouped[i] ? groupEntity.get(id) : undefined;
    if (merged !== undefined) {
      drafts[merged].parts.push(o);
      entityOf.push(merged);
      return;
    }
    const own = id !== null && !used.has(id) && (grouped[i] || !groupOwned.has(id));
    if (id !== null && !own) report.warn('duplicate-id', n => `${plural(n, 'object')} repeat an IFC::GlobalId outside its group and got a new id; the stated id stays in their properties.`);
    const globalId = own ? id : derive(o, i);
    used.add(globalId);
    if (own && grouped[i]) groupEntity.set(globalId, drafts.length);
    entityOf.push(drafts.length);
    drafts.push({ globalId, parts: [o] });
  });
  // Columns and property sets are read once every part's user text is in.
  const entities = drafts.map(({ globalId, parts }): RhinoImportEntity => {
    const [first] = parts, userStrings = parts.length === 1 ? first.userStrings : mergeUserText(parts);
    const className = columnString(parts, 'Class').trim();
    const ifcClass = className ? classes.product(className) : null;
    if (className && !ifcClass) report.warn('class', n => `${plural(n, 'object')} name an IFC::Class that is not an IFC product class and are imported as ${FALLBACK_CLASS}.`);
    return {
      globalId, ifcClass: ifcClass ?? FALLBACK_CLASS,
      name: columnString(parts, 'Name') || first.name || first.type,
      description: columnString(parts, 'Description'),
      objectType: columnString(parts, 'ObjectType'),
      layer: first.layer, hidden: parts.every(part => part.hidden), hiddenByObject: parts.every(part => part.hiddenByObject),
      hiddenByLayer: parts.every(part => part.hiddenByLayer), objectIds: parts.map(part => part.id), geometryType: first.type,
      userStrings, propertySets: propertySets(first, userStrings),
    };
  });
  return { entities, entityOf };
}
