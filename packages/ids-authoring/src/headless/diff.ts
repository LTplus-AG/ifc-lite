/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal semantic diff of two IDS documents, for `ifc-lite ids diff`
 * and the MCP `ids_diff` tool.
 *
 * Matching is the re-identification cascade (`reidentify`): specifications
 * by identifier, then name + applicability signature, then similarity;
 * facets within a matched specification the same way. Matched nodes keep
 * one node id, so "changed" is "same node id, different content", and a
 * renamed specification is a change, not a remove plus an add.
 *
 * This is the shell the CLI and MCP surfaces need now. The full engine of
 * IDS-104 (field-level paths inside constraints, a plain-language
 * changelog, three-way merge) supersedes it; when it lands, this module is
 * deleted and the surfaces call that engine instead.
 */

import type { IDSDocument, IDSFacet, IDSInfo, IDSRequirement, IDSSpecification, RequirementOptionality } from '@ifc-lite/ids';
import type { Section, StudioDocument } from '../document/types.js';
import { reidentify, type ReidentifyReport } from '../match/reidentify.js';
import { describeFacet } from '../render/describe.js';
import { studioDocumentFromIds } from './read.js';
import { lostPaths } from './write.js';

export type IdsDiffChange = 'added' | 'removed' | 'changed';

export interface IdsDiffEntry {
  change: IdsDiffChange;
  node: 'info' | 'spec' | 'facet';
  /** The specification's name (the new one when it was renamed). */
  spec?: string;
  /** XML path of the node: in the new document, or in the old one for `removed`. */
  path: string;
  /** For `changed`: the field that differs (`name`, `cardinality`, `facet`, `optionality`, …). */
  field?: string;
  before?: string;
  after?: string;
  /** One plain-language line. */
  text: string;
}

export interface IdsDiff {
  identical: boolean;
  entries: IdsDiffEntry[];
  /** How specifications and facets were paired. */
  matching: ReidentifyReport;
}

const INFO_FIELDS: readonly (keyof IDSInfo)[] = ['title', 'copyright', 'version', 'description', 'author', 'date', 'purpose', 'milestone'];

function same(a: unknown, b: unknown): boolean {
  return lostPaths(a, b).length === 0 && lostPaths(b, a).length === 0;
}

function cardinality(spec: IDSSpecification): 'required' | 'optional' | 'prohibited' {
  if (spec.maxOccurs === 0) return 'prohibited';
  return (spec.minOccurs ?? 0) > 0 ? 'required' : 'optional';
}

function specFields(spec: IDSSpecification): Record<string, string | undefined> {
  return {
    name: spec.name,
    identifier: spec.identifier,
    description: spec.description,
    instructions: spec.instructions,
    ifcVersion: spec.ifcVersions.join(' '),
    cardinality: cardinality(spec),
  };
}

interface FacetSlot {
  facet: IDSFacet;
  requirement?: IDSRequirement;
  index: number;
}

function slots(doc: StudioDocument, specIndex: number, section: Section): Map<string, FacetSlot> {
  const spec = doc.ids.specifications[specIndex];
  const nodes = doc.nodes.specs[specIndex];
  const out = new Map<string, FacetSlot>();
  if (section === 'applicability') {
    spec.applicability.facets.forEach((facet, index) => out.set(nodes.applicability[index].id, { facet, index }));
  } else {
    spec.requirements.forEach((requirement, index) =>
      out.set(nodes.requirements[index].id, { facet: requirement.facet, requirement, index }),
    );
  }
  return out;
}

function describe(slot: FacetSlot, section: Section): string {
  return describeFacet(slot.facet, section, (slot.requirement?.optionality ?? 'required') as RequirementOptionality);
}

function diffFacets(a: StudioDocument, ai: number, b: StudioDocument, bi: number, out: IdsDiffEntry[]): void {
  const spec = b.ids.specifications[bi].name;
  for (const section of ['applicability', 'requirements'] as const) {
    const before = slots(a, ai, section);
    const after = slots(b, bi, section);
    const label = section === 'applicability' ? 'applicability' : 'requirement';
    for (const [id, slot] of after) {
      const path = `specifications[${bi}].${section}[${slot.index}]`;
      const old = before.get(id);
      if (!old) {
        out.push({ change: 'added', node: 'facet', spec, path, text: `${spec}: ${label} added: ${describe(slot, section)}` });
        continue;
      }
      if (!same(old.facet, slot.facet)) {
        const was = describe(old, section);
        const now = describe(slot, section);
        out.push({ change: 'changed', node: 'facet', spec, path, field: 'facet', before: was, after: now, text: `${spec}: ${label} changed: ${was} → ${now}` });
      } else if (old.requirement && slot.requirement && old.requirement.optionality !== slot.requirement.optionality) {
        const [was, now] = [old.requirement.optionality, slot.requirement.optionality];
        const what = describeFacet(slot.facet, section);
        out.push({ change: 'changed', node: 'facet', spec, path, field: 'optionality', before: was, after: now, text: `${spec}: ${label} changed from ${was} to ${now}: ${what}` });
      }
      if (old.requirement?.instructions !== slot.requirement?.instructions) {
        out.push({ change: 'changed', node: 'facet', spec, path, field: 'instructions', before: old.requirement?.instructions, after: slot.requirement?.instructions, text: `${spec}: instructions of a requirement changed` });
      }
    }
    for (const [id, slot] of before) {
      if (after.has(id)) continue;
      const path = `specifications[${ai}].${section}[${slot.index}]`;
      out.push({ change: 'removed', node: 'facet', spec, path, text: `${spec}: ${label} removed: ${describe(slot, section)}` });
    }
  }
}

/** Compare `before` with `after`. Pure; never throws on parsed input. */
export function diffIds(before: IDSDocument, after: IDSDocument): IdsDiff {
  const a = studioDocumentFromIds(before);
  const { doc: b, report } = reidentify(a, after);
  const entries: IdsDiffEntry[] = [];

  for (const field of INFO_FIELDS) {
    const [was, now] = [before.info[field], after.info[field]];
    if (was !== now) entries.push({ change: 'changed', node: 'info', path: `info.${field}`, field, before: was, after: now, text: `Document ${field} changed from "${was ?? ''}" to "${now ?? ''}"` });
  }

  const indexOfA = new Map(a.nodes.specs.map((s, i) => [s.id, i]));
  b.nodes.specs.forEach((nodes, bi) => {
    const spec = b.ids.specifications[bi];
    const ai = indexOfA.get(nodes.id);
    if (ai === undefined) {
      entries.push({ change: 'added', node: 'spec', spec: spec.name, path: `specifications[${bi}]`, text: `Specification "${spec.name}" added` });
      return;
    }
    const was = specFields(a.ids.specifications[ai]);
    const now = specFields(spec);
    for (const field of Object.keys(now)) {
      if (was[field] === now[field]) continue;
      entries.push({
        change: 'changed', node: 'spec', spec: spec.name, path: `specifications[${bi}]`, field, before: was[field], after: now[field],
        text: field === 'name' ? `Specification "${was.name}" renamed to "${now.name}"` : `${spec.name}: ${field} changed from "${was[field] ?? ''}" to "${now[field] ?? ''}"`,
      });
    }
    diffFacets(a, ai, b, bi, entries);
  });

  const removed = new Set(report.specs.removed);
  a.nodes.specs.forEach((nodes, ai) => {
    if (!removed.has(nodes.id)) return;
    const name = a.ids.specifications[ai].name;
    entries.push({ change: 'removed', node: 'spec', spec: name, path: `specifications[${ai}]`, text: `Specification "${name}" removed` });
  });

  return { identical: entries.length === 0, entries, matching: report };
}
