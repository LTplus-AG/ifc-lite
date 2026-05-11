/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relationship-level operations on the Y.Doc.
 *
 * Relationships are stored in their own top-level Y.Map so concurrent edits
 * to the source/target lists don't collide with edits on the entities they
 * reference (spec §5.2).
 */

import * as Y from 'yjs';
import { RELATIONSHIP_KEY, relationshipsMap } from './schema.js';

export interface CreateRelationshipOptions {
  ifcClass: string;
  source: string;
  targets?: string[];
  attributes?: Record<string, unknown>;
}

export function getRelationship(doc: Y.Doc, path: string): Y.Map<unknown> | undefined {
  return relationshipsMap(doc).get(path) as Y.Map<unknown> | undefined;
}

export function createRelationship(
  doc: Y.Doc,
  path: string,
  options: CreateRelationshipOptions,
): Y.Map<unknown> {
  const rels = relationshipsMap(doc);
  const existing = rels.get(path);
  if (existing) return existing;

  const rel = new Y.Map<unknown>();
  rel.set(RELATIONSHIP_KEY.IFC_CLASS, options.ifcClass);
  rel.set(RELATIONSHIP_KEY.SOURCE, options.source);

  const targets = new Y.Array<string>();
  if (options.targets && options.targets.length > 0) {
    targets.push(options.targets);
  }
  rel.set(RELATIONSHIP_KEY.TARGETS, targets);

  const attrs = new Y.Map<unknown>();
  if (options.attributes) {
    for (const [k, v] of Object.entries(options.attributes)) {
      attrs.set(k, v);
    }
  }
  rel.set(RELATIONSHIP_KEY.ATTRIBUTES, attrs);

  rels.set(path, rel);
  return rel;
}

export function deleteRelationship(doc: Y.Doc, path: string): boolean {
  const rels = relationshipsMap(doc);
  if (!rels.has(path)) return false;
  rels.delete(path);
  return true;
}

export function addTarget(doc: Y.Doc, path: string, targetPath: string): void {
  const rel = getRelationship(doc, path);
  if (!rel) throw new Error(`@ifc-lite/collab: relationship "${path}" not found`);
  const targets = rel.get(RELATIONSHIP_KEY.TARGETS) as Y.Array<string> | undefined;
  if (!targets) throw new Error(`@ifc-lite/collab: relationship "${path}" missing targets`);
  // Push preserves concurrent additions per CRDT semantics; dedupe is left
  // to the caller because IFC relationships occasionally allow duplicates.
  targets.push([targetPath]);
}

export function removeTarget(doc: Y.Doc, path: string, targetPath: string): boolean {
  const rel = getRelationship(doc, path);
  if (!rel) return false;
  const targets = rel.get(RELATIONSHIP_KEY.TARGETS) as Y.Array<string> | undefined;
  if (!targets) return false;
  const arr = targets.toArray();
  let removed = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === targetPath) {
      targets.delete(i, 1);
      removed = true;
    }
  }
  return removed;
}

export function getTargets(doc: Y.Doc, path: string): string[] {
  const rel = getRelationship(doc, path);
  if (!rel) return [];
  const targets = rel.get(RELATIONSHIP_KEY.TARGETS) as Y.Array<string> | undefined;
  return targets ? targets.toArray() : [];
}

/**
 * Cascade relationship cleanup when an entity is deleted. Removes the
 * entity from any relationship's targets and deletes relationships that
 * had it as their source.
 */
export function cascadeDeleteRelationships(doc: Y.Doc, entityPath: string): void {
  const rels = relationshipsMap(doc);
  const toDelete: string[] = [];
  doc.transact(() => {
    for (const [relPath, relUntyped] of rels.entries()) {
      const rel = relUntyped as Y.Map<unknown>;
      const source = rel.get(RELATIONSHIP_KEY.SOURCE);
      if (source === entityPath) {
        toDelete.push(relPath);
        continue;
      }
      const targets = rel.get(RELATIONSHIP_KEY.TARGETS) as Y.Array<string> | undefined;
      if (!targets) continue;
      const arr = targets.toArray();
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === entityPath) targets.delete(i, 1);
      }
    }
    for (const path of toDelete) rels.delete(path);
  });
}
