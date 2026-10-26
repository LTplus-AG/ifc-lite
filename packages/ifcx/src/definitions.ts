/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What IFCX says with `inherits` that IFC says with entities of its own:
 * a type definition (`IfcWindowType`, related to its occurrences by
 * `IfcRelDefinesByType`) and a material (`IfcMaterial`, related to what is made
 * of it by `IfcRelAssociatesMaterial`).
 *
 * In `hello-wall.ifcx` the window type is a node of class `IfcWindow` that the
 * two windows inherit as `windowType`, and the materials are class-less nodes
 * carrying `bsi::ifc::material` that the wall, and the type's `Frame` and
 * `Glazing` parts, inherit as `material`. Composition copies what is inherited
 * into the inheriting node and forgets the reference, so this reads it from
 * `ComposedNode.inherits`.
 */

import { IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';
import type { ComposedNode, IfcClass } from './types.js';
import { ATTR } from './types.js';

const classCode = (node: ComposedNode | undefined): string | undefined =>
  (node?.attributes.get(ATTR.CLASS) as IfcClass | undefined)?.code;

/**
 * The edge that says "typed by" for an occurrence of `occurrenceClass`: the class name, without `Ifc`, lower-camel,
 * then `Type` (`IfcWindow` gives `windowType`). That is the one spelling the buildingSMART Hello Wall sample uses
 * (`"inherits": { "windowType": ... }`); no IFC5 document in this repository or reachable from it lists the names,
 * so this is the sample's convention, matched exactly. A suffix test would retype the target of any edge named
 * `prototype`.
 */
const typeEdgeOf = (occurrenceClass: string | undefined): string | null =>
  occurrenceClass?.startsWith('Ifc') && occurrenceClass.length > 3 ? `${occurrenceClass[3].toLowerCase()}${occurrenceClass.slice(4)}Type` : null;
const isMaterialEdge = (name: string): boolean => name.toLowerCase() === 'material';

/**
 * The nodes that define a type, by path, with the class of the type: a node
 * that other classed nodes inherit through a `...Type` edge and whose own class
 * has a type class (`IfcWindow` has `IfcWindowType`). Such a node is the type
 * object, not an element: it has no placement and sits on no storey, as
 * `IfcWindowType` does not in IFC.
 */
export function typeDefinitions(composed: ReadonlyMap<string, ComposedNode>): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of composed.values()) {
    if (!classCode(node)) continue;
    for (const [edge, target] of Object.entries(node.inherits ?? {})) {
      if (edge !== typeEdgeOf(classCode(node)) || target === node.path || out.has(target)) continue;
      const own = classCode(composed.get(target));
      if (!own || own.toUpperCase().endsWith('TYPE')) continue;
      if (IfcTypeEnumFromString(`${own}Type`) !== IfcTypeEnum.Unknown) out.set(target, `${own}Type`);
    }
  }
  return out;
}

/** The nodes that define a material, by path, with the material's `bsi::ifc::material` code (its name). */
export function materialDefinitions(composed: ReadonlyMap<string, ComposedNode>): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of composed.values()) {
    for (const [edge, target] of Object.entries(node.inherits ?? {})) {
      if (!isMaterialEdge(edge) || out.has(target)) continue;
      const code = (composed.get(target)?.attributes.get(ATTR.MATERIAL) as { code?: unknown } | undefined)?.code;
      if (typeof code === 'string' && code.trim()) out.set(target, code);
    }
  }
  return out;
}

/**
 * The classed nodes an inheriting node belongs to: itself when it has a class,
 * else the classed nodes above it (the `Frame` part of a window type belongs to
 * the type). Parts of a part are followed up through every parent.
 */
export function owningEntityPaths(
  path: string,
  composed: ReadonlyMap<string, ComposedNode>,
  parentsOf: ReadonlyMap<string, readonly string[]>,
): string[] {
  const owners: string[] = [];
  const seen = new Set<string>();
  const queue = [path];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (seen.has(at)) continue;
    seen.add(at);
    if (classCode(composed.get(at))) owners.push(at);
    else queue.push(...(parentsOf.get(at) ?? []));
  }
  return owners;
}

/** Every node's parents, by path. */
export function parentPaths(composed: ReadonlyMap<string, ComposedNode>): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const node of composed.values()) {
    for (const child of node.children.values()) {
      const list = parents.get(child.path);
      if (list) list.push(node.path);
      else parents.set(child.path, [node.path]);
    }
  }
  return parents;
}

/** One `IfcRelAssociatesMaterial` edge: the material's path and the classed node made of it. */
export function materialAssociations(composed: ReadonlyMap<string, ComposedNode>): { materialPath: string; ownerPath: string }[] {
  const materials = materialDefinitions(composed);
  const types = typeDefinitions(composed);
  const parents = parentPaths(composed);
  const out: { materialPath: string; ownerPath: string }[] = [];
  for (const node of composed.values()) {
    for (const [edge, target] of Object.entries(node.inherits ?? {})) {
      if (!isMaterialEdge(edge) || !materials.has(target)) continue;
      // A part of a type (the Frame of a window type) is also a child of every occurrence that inherited the
      // type, but the material is the TYPE's: IFC associates it with the IfcWindowType and the windows take
      // it from there. So when the type is among the owners, the occurrences that merely inherit it are not.
      const owners = owningEntityPaths(node.path, composed, parents);
      const typed = owners.filter((owner) => types.has(owner));
      for (const ownerPath of typed.length > 0 ? typed : owners) {
        if (ownerPath !== target) out.push({ materialPath: target, ownerPath });
      }
    }
  }
  return out;
}

/** One `IfcRelDefinesByType` edge: the type's path and the classed node it types. */
export function typeAssociations(composed: ReadonlyMap<string, ComposedNode>): { typePath: string; objectPath: string }[] {
  const types = typeDefinitions(composed);
  const out: { typePath: string; objectPath: string }[] = [];
  for (const node of composed.values()) {
    if (!classCode(node)) continue;
    for (const [edge, target] of Object.entries(node.inherits ?? {})) {
      if (edge === typeEdgeOf(classCode(node)) && types.has(target) && target !== node.path) out.push({ typePath: target, objectPath: node.path });
    }
  }
  return out;
}

/**
 * A node's own `inherits` references as the `ComposedNode` field to spread in: each path resolved, null removal masks
 * dropped, and no field at all when none are left (see `ComposedNode.inherits`).
 */
export function inheritsField(
  refs: Readonly<Record<string, string | null>> | undefined,
  resolve: (path: string) => string | null | undefined,
): { inherits?: Record<string, string> } {
  const entries = Object.entries(refs ?? {}).filter((entry): entry is [string, string] => !!entry[1]);
  return entries.length === 0 ? {} : { inherits: Object.fromEntries(entries.map(([edge, path]) => [edge, resolve(path) ?? path])) };
}
