/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isValidIfcGuid, isValidUuid, uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import type { RhinoUserStrings } from '../types.js';
import type { IfcClasses } from './ifc-classes.js';
import { plural, type Report } from './report.js';
import type { RhinoImportEntity, RhinoImportPropertySet } from './types.js';

export const FALLBACK_CLASS = 'IfcBuildingElementProxy';
/** Namespace for the GlobalId of an object whose own UUID cannot supply one. */
const FALLBACK_NAMESPACE = '6f1e2b0a-7c1d-4f7e-9d59-3c0f4a1d2b77';
/** `IFC::*` keys that fill entity columns instead of the `IFC` property set. */
const COLUMN_KEYS = new Set(['description', 'objecttype']);

/** What identity needs to know about one drawn top-level object. */
export interface ObjectFacts {
  id: string; name: string; type: string; layer: number; layerPath: string; hidden: boolean;
  groups: number[]; userStrings: RhinoUserStrings; material: string;
}

/** Look up a user string. openNURBS keys ignore case, so `ifc::globalid` is `IFC::GlobalId`. */
export function userString(strings: RhinoUserStrings, key: string): string | undefined {
  const wanted = key.toLowerCase();
  return strings.find(([k]) => k.toLowerCase() === wanted)?.[1];
}

/**
 * Sort Attribute User Text into property sets. A key splits at its first `::`
 * into set and property, as the exporter wrote it; a key without one goes to
 * `Attribute User Text`, and so does a `Rhino::` key, because the `Rhino` set
 * holds only what the reader derives. Values stay strings: user text has no types.
 */
function propertySets(o: ObjectFacts): RhinoImportPropertySet[] {
  const sets = new Map<string, [string, string][]>();
  const put = (set: string, name: string, value: string) => {
    const properties = sets.get(set);
    if (properties) properties.push([name, value]); else sets.set(set, [[name, value]]);
  };
  for (const [key, value] of o.userStrings) {
    const at = key.indexOf('::'), set = key.slice(0, at), name = key.slice(at + 2);
    const setKey = set.trim().toLowerCase();
    if (at <= 0 || !name || setKey === 'rhino') put('Attribute User Text', key, value);
    else if (setKey !== 'ifc') put(set, name, value);
    else if (!COLUMN_KEYS.has(name.toLowerCase())) put('IFC', name, value);
  }
  put('Rhino', 'Layer', o.layerPath);
  put('Rhino', 'ObjectType', o.type);
  put('Rhino', 'ObjectId', o.id);
  if (o.material) put('Rhino', 'Material', o.material);
  return Array.from(sets, ([name, properties]) => ({ name, properties }));
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
    const id = userString(o.userStrings, 'IFC::GlobalId');
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
  const entities: RhinoImportEntity[] = [], entityOf: number[] = [];
  objects.forEach((o, i) => {
    const id = stated[i];
    const merged = id !== null && grouped[i] ? groupEntity.get(id) : undefined;
    if (merged !== undefined) {
      entities[merged].objectIds.push(o.id);
      entities[merged].hidden &&= o.hidden;
      entityOf.push(merged);
      return;
    }
    const own = id !== null && !used.has(id) && (grouped[i] || !groupOwned.has(id));
    if (id !== null && !own) report.warn('duplicate-id', n => `${plural(n, 'object')} repeat an IFC::GlobalId outside its group and got a new id; the stated id stays in their properties.`);
    const globalId = own ? id : derive(o, i);
    used.add(globalId);
    if (own && grouped[i]) groupEntity.set(globalId, entities.length);
    const className = userString(o.userStrings, 'IFC::Class')?.trim();
    const ifcClass = className ? classes.product(className) : null;
    if (className && !ifcClass) report.warn('class', n => `${plural(n, 'object')} name an IFC::Class that is not an IFC product class and are imported as ${FALLBACK_CLASS}.`);
    entityOf.push(entities.length);
    entities.push({
      globalId, ifcClass: ifcClass ?? FALLBACK_CLASS,
      name: userString(o.userStrings, 'IFC::Name') || o.name || o.type,
      description: userString(o.userStrings, 'IFC::Description') ?? '',
      objectType: userString(o.userStrings, 'IFC::ObjectType') ?? '',
      layer: o.layer, hidden: o.hidden, objectIds: [o.id], geometryType: o.type,
      userStrings: o.userStrings, propertySets: propertySets(o),
    });
  });
  return { entities, entityOf };
}
