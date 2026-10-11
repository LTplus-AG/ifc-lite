/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural-sharing helpers for the reducer. Every helper returns new
 * objects along the changed path only; untouched specs, facets and node
 * records are shared with the previous document.
 */

import type { IDSFacet, IDSRequirement, IDSSpecification } from '@ifc-lite/ids';
import { facetAt, facetNodesAt, locateFacet, locateSpec, type FacetLocation } from '../document/node-index.js';
import type { FacetNodes, Section, SpecNodes, StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';

/** Raised when an op cannot be applied. The gate should have refused it. */
export class OpApplyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpApplyError';
  }
}

export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const out = list.slice();
  out.splice(index, 0, item);
  return out;
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  const out = list.slice();
  out.splice(index, 1);
  return out;
}

export function replaceAt<T>(list: readonly T[], index: number, item: T): T[] {
  const out = list.slice();
  out[index] = item;
  return out;
}

/** Copy of `obj` with `key` set, or removed when `value` is undefined/null. */
export function withKey<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | null | undefined): T {
  const next = { ...obj };
  if (value === undefined || value === null) delete next[key];
  else next[key] = value;
  return next;
}

export function requireSpec(doc: StudioDocument, specId: Uuid): number {
  const index = locateSpec(doc, specId);
  if (index === undefined) throw new OpApplyError('GATE-STR-001', `unknown specification ${specId}`);
  return index;
}

export function requireFacet(doc: StudioDocument, facetId: Uuid): FacetLocation {
  const loc = locateFacet(doc, facetId);
  if (!loc) throw new OpApplyError('GATE-STR-001', `unknown facet ${facetId}`);
  return loc;
}

export function requireIndex(index: number, max: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new OpApplyError('GATE-STR-006', `${what} ${index} is out of range 0..${max}`);
  }
}

export function setSpec(doc: StudioDocument, index: number, spec: IDSSpecification, nodes: SpecNodes): StudioDocument {
  return {
    ...doc,
    ids: { ...doc.ids, specifications: replaceAt(doc.ids.specifications, index, spec) },
    nodes: { ...doc.nodes, specs: replaceAt(doc.nodes.specs, index, nodes) },
  };
}

export function insertSpec(doc: StudioDocument, index: number, spec: IDSSpecification, nodes: SpecNodes): StudioDocument {
  return {
    ...doc,
    ids: { ...doc.ids, specifications: insertAt(doc.ids.specifications, index, spec) },
    nodes: { ...doc.nodes, specs: insertAt(doc.nodes.specs, index, nodes) },
  };
}

export function removeSpec(doc: StudioDocument, index: number): StudioDocument {
  return {
    ...doc,
    ids: { ...doc.ids, specifications: removeAt(doc.ids.specifications, index) },
    nodes: { ...doc.nodes, specs: removeAt(doc.nodes.specs, index) },
  };
}

/** One entry of a section: the facet, its nodes and (requirements only) the requirement. */
export interface SectionItem {
  facet: IDSFacet;
  nodes: FacetNodes;
  requirement?: IDSRequirement;
}

export function itemAt(doc: StudioDocument, loc: FacetLocation): SectionItem {
  const facet = facetAt(doc, loc);
  const nodes = facetNodesAt(doc, loc);
  if (loc.section === 'applicability') return { facet, nodes };
  return { facet, nodes, requirement: doc.ids.specifications[loc.specIndex].requirements[loc.facetIndex] };
}

type SectionEdit = <T>(list: readonly T[]) => T[];

function editSection(doc: StudioDocument, specIndex: number, section: Section, edit: SectionEdit): StudioDocument {
  const spec = doc.ids.specifications[specIndex];
  const nodes = doc.nodes.specs[specIndex];
  if (section === 'applicability') {
    return setSpec(
      doc,
      specIndex,
      { ...spec, applicability: { ...spec.applicability, facets: edit(spec.applicability.facets) } },
      { ...nodes, applicability: edit(nodes.applicability) },
    );
  }
  return setSpec(doc, specIndex, { ...spec, requirements: edit(spec.requirements) }, { ...nodes, requirements: edit(nodes.requirements) });
}

/** The value stored in a section array for `item`. */
function sectionValue(section: Section, item: SectionItem): IDSFacet | IDSRequirement {
  if (section === 'applicability') return item.facet;
  if (!item.requirement) throw new OpApplyError('GATE-STR-003', 'a requirement needs its optionality');
  return { ...item.requirement, id: item.nodes.id, facet: item.facet };
}

export function insertItem(doc: StudioDocument, specIndex: number, section: Section, index: number, item: SectionItem): StudioDocument {
  const value = sectionValue(section, item);
  const spec = doc.ids.specifications[specIndex];
  const nodes = doc.nodes.specs[specIndex];
  if (section === 'applicability') {
    return setSpec(
      doc,
      specIndex,
      { ...spec, applicability: { ...spec.applicability, facets: insertAt(spec.applicability.facets, index, value as IDSFacet) } },
      { ...nodes, applicability: insertAt(nodes.applicability, index, item.nodes) },
    );
  }
  return setSpec(
    doc,
    specIndex,
    { ...spec, requirements: insertAt(spec.requirements, index, value as IDSRequirement) },
    { ...nodes, requirements: insertAt(nodes.requirements, index, item.nodes) },
  );
}

export function replaceItem(doc: StudioDocument, loc: FacetLocation, item: SectionItem): StudioDocument {
  const removed = removeItem(doc, loc);
  return insertItem(removed, loc.specIndex, loc.section, loc.facetIndex, item);
}

export function removeItem(doc: StudioDocument, loc: FacetLocation): StudioDocument {
  return editSection(doc, loc.specIndex, loc.section, (list) => removeAt(list, loc.facetIndex));
}

export function moveItemWithin(doc: StudioDocument, loc: FacetLocation, toIndex: number): StudioDocument {
  return editSection(doc, loc.specIndex, loc.section, (list) => {
    const out = removeAt(list, loc.facetIndex);
    out.splice(toIndex, 0, list[loc.facetIndex]);
    return out;
  });
}

export function sectionLength(doc: StudioDocument, specIndex: number, section: Section): number {
  const spec = doc.ids.specifications[specIndex];
  return section === 'applicability' ? spec.applicability.facets.length : spec.requirements.length;
}
