/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a diff entry changes, for the three-way merge. Each entry has one
 * KEY (the unit two sides can disagree on: a field of a node, a node's
 * existence, a node's place) and the node ids it lives under. Two sides
 * conflict when they change one key differently, or when one deletes a
 * node the other edits.
 */

import type { DiffEntry } from '../diff/types.js';
import type { Uuid } from '../uuid.js';

export interface EntryScope {
  key: string;
  /** Node ids the change lives under (spec, facet). */
  nodes: Uuid[];
  /** The node this entry deletes, if it is a removal. */
  deletes?: Uuid;
}

export function scopeOf(e: DiffEntry): EntryScope {
  switch (e.kind) {
    case 'info.changed':
      return { key: `info:${e.field}`, nodes: [] };
    case 'custom.psetDeclared':
    case 'custom.psetRemoved':
      return { key: `pset:${e.decl.name}`, nodes: [] };
    case 'custom.userDefinedTypeDeclared':
    case 'custom.userDefinedTypeRemoved':
      return { key: `udt:${e.decl.entity.toUpperCase()}:${e.decl.value.toUpperCase()}`, nodes: [] };
    case 'spec.added':
      return { key: `spec:${e.specId}:exists`, nodes: [e.specId] };
    case 'spec.removed':
      return { key: `spec:${e.specId}:exists`, nodes: [e.specId], deletes: e.specId };
    case 'spec.moved':
      return { key: `spec:${e.specId}:order`, nodes: [e.specId] };
    case 'spec.changed': {
      // min/max occurrences are one decision (the cardinality).
      const field = e.field === 'minOccurs' || e.field === 'maxOccurs' ? 'occurs' : e.field;
      return { key: `spec:${e.specId}:${field}`, nodes: [e.specId] };
    }
    case 'facet.added':
      return { key: `facet:${e.facetId}:exists`, nodes: [e.specId, e.facetId] };
    case 'facet.removed':
      return { key: `facet:${e.facetId}:exists`, nodes: [e.specId, e.facetId], deletes: e.facetId };
    case 'facet.moved': {
      const across = e.from.specId !== e.to.specId || e.from.section !== e.to.section;
      return { key: `facet:${e.facetId}:${across ? 'place' : 'order'}`, nodes: [e.from.specId, e.to.specId, e.facetId] };
    }
    case 'facet.replaced':
      return { key: `facet:${e.facetId}:content`, nodes: [e.specId, e.facetId] };
    case 'facet.valueChanged':
      return { key: `facet:${e.facetId}:${e.field}`, nodes: [e.specId, e.facetId] };
    case 'facet.relationChanged':
      return { key: `facet:${e.facetId}:relation`, nodes: [e.specId, e.facetId] };
    case 'requirement.changed':
      return { key: `facet:${e.facetId}:req.${e.field}`, nodes: [e.specId, e.facetId] };
  }
}

/** Keys whose disagreement is settled by last-writer-wins (theirs) with a diagnostic. */
export function isOrderKey(key: string): boolean {
  return key.endsWith(':order');
}

/** A replaced facet conflicts with any other edit of that facet. */
export function contentKeyOf(key: string): string | undefined {
  const m = /^facet:([^:]+):/.exec(key);
  return m ? `facet:${m[1]}:content` : undefined;
}
