/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Store } from 'n3';
import { LIMITS } from './types.js';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SH = 'http://www.w3.org/ns/shacl#';

/** The installed validator recursively traverses subclasses. Reject unsafe RDF
 * before handing it off: cycles, deep acyclic paths and repeated DAG fan-out
 * require separate checks. The raw imported graph remains unchanged. */
export function assertBoundedSubclasses(store: Store): void {
  const children = new Map<string, Set<string>>(); const parents = new Map<string, Set<string>>();
  for (const quad of store.getQuads(null, RDFS + 'subClassOf', null, null)) {
    if (!['NamedNode', 'BlankNode'].includes(quad.object.termType)) throw new Error('RDFS subclass relationships require resource nodes');
    const child = `${quad.subject.termType}:${quad.subject.value}`; const parent = `${quad.object.termType}:${quad.object.value}`;
    const descendants = children.get(parent) ?? new Set<string>(); descendants.add(child); children.set(parent, descendants);
    if (!children.has(child)) children.set(child, new Set());
    const ancestors = parents.get(child) ?? new Set<string>(); ancestors.add(parent); parents.set(child, ancestors);
  }
  const remaining = new Map([...children].map(([node, values]) => [node, values.size]));
  const work = new Map([...children.keys()].map(node => [node, 1]));
  const depth = new Map([...children.keys()].map(node => [node, 1]));
  const queue = [...children.keys()].filter(node => remaining.get(node) === 0);
  let processed = 0; let total = 0;
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]; processed++; total += work.get(node)!;
    if (total > LIMITS.quads * 2) throw new Error('RDFS subclass traversal exceeds the supported work budget');
    for (const parent of parents.get(node) ?? []) {
      const parentWork = work.get(parent)! + work.get(node)!;
      const parentDepth = Math.max(depth.get(parent)!, depth.get(node)! + 1);
      if (parentWork > LIMITS.quads) throw new Error('RDFS subclass DAG exceeds the supported work budget');
      if (parentDepth > 64) throw new Error('RDFS subclass traversal exceeds the supported 64-level depth');
      work.set(parent, parentWork); depth.set(parent, parentDepth);
      const count = remaining.get(parent)! - 1; remaining.set(parent, count);
      if (!count) queue.push(parent);
    }
  }
  if (processed !== children.size) throw new Error('Cyclic RDFS subclass relationships are unsupported');
}

/** SHACL instances include explicitly typed subclasses in the supplied graph.
 * This is local SHACL class membership, without remote ontologies or OWL inference. */
export function countShapeTargets(data: Store, shapes: Store): number {
  if (shapes.countQuads(null, RDF + 'type', RDFS + 'Class', null)) throw new Error('Implicit class shapes are unsupported; declare explicit SHACL targets');
  if (shapes.countQuads(null, RDFS + 'subClassOf', null, null)) throw new Error('Subclass definitions in shapes are unsupported; supply local class relationships in the data graph');
  let targets = shapes.countQuads(null, SH + 'targetNode', null, null);
  // Membership is a pure function of a class and this data graph. A global set
  // avoids re-walking shared subclass DAGs across repeated target declarations.
  const visited = new Set<string>();
  for (const target of shapes.getQuads(null, SH + 'targetClass', null, null)) {
    const pending = [target.object];
    while (pending.length) {
      const current = pending.pop()!; const key = `${current.termType}:${current.value}`;
      if (visited.has(key)) continue;
      visited.add(key); targets += data.countQuads(null, RDF + 'type', current, null);
      for (const subclass of data.getQuads(null, RDFS + 'subClassOf', current, null)) pending.push(subclass.subject);
    }
  }
  for (const target of shapes.getQuads(null, SH + 'targetSubjectsOf', null, null)) targets += data.countQuads(null, target.object, null, null);
  for (const target of shapes.getQuads(null, SH + 'targetObjectsOf', null, null)) targets += data.countQuads(null, target.object, null, null);
  return targets;
}
