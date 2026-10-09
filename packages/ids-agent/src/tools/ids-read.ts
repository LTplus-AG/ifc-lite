/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ids_read`: the sandbox document as the model sees it. Three views:
 *
 * - `summary`: spec ids, names, versions, cardinality and one plain-language
 *   line per facet, with node ids so ops can address them;
 * - `full`: the IDS content of the selected specs with node ids beside it;
 * - `plain`: plain-language sentences only (Explain mode).
 *
 * The same summary is what the loop puts in the volatile context of every
 * request, so the model never has to guess node ids.
 */

import type { IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import { describeFacet, type FacetNodes, type SpecNodes, type StudioDocument, type Uuid } from '@ifc-lite/ids-authoring';
import { objectSchema, type AgentToolContext, type IdsAgentTool } from './context.js';
import { defineTool, success } from './registry.js';

type View = 'summary' | 'full' | 'plain';

function cardinality(spec: IDSSpecification): 'required' | 'optional' | 'prohibited' {
  if (spec.maxOccurs === 0) return 'prohibited';
  return (spec.minOccurs ?? 0) > 0 ? 'required' : 'optional';
}

function facetLine(facet: IDSFacet, section: 'applicability' | 'requirements', optionality?: 'required' | 'optional' | 'prohibited'): string {
  return describeFacet(facet, section, optionality ?? 'required', 'en');
}

function selected(doc: StudioDocument, specIds?: readonly string[]): { spec: IDSSpecification; nodes: SpecNodes }[] {
  const wanted = specIds && specIds.length > 0 ? new Set(specIds) : null;
  return doc.ids.specifications
    .map((spec, i) => ({ spec, nodes: doc.nodes.specs[i] }))
    .filter(({ nodes }) => !wanted || wanted.has(nodes.id));
}

function facetEntries(facets: readonly IDSFacet[], nodes: readonly FacetNodes[], section: 'applicability' | 'requirements',
  optionalities?: readonly ('required' | 'optional' | 'prohibited')[]) {
  return facets.map((facet, i) => ({ facetId: nodes[i]?.id as Uuid, type: facet.type, text: facetLine(facet, section, optionalities?.[i]) }));
}

/** The compact document view used by `ids_read` and by the loop's context block. */
export function summarizeDocument(doc: StudioDocument, specIds?: readonly string[]) {
  return {
    title: doc.ids.info.title,
    specificationCount: doc.ids.specifications.length,
    specifications: selected(doc, specIds).map(({ spec, nodes }) => ({
      specId: nodes.id,
      name: spec.name,
      ifcVersions: spec.ifcVersions,
      cardinality: cardinality(spec),
      ...(spec.identifier ? { identifier: spec.identifier } : {}),
      applicability: facetEntries(spec.applicability.facets, nodes.applicability, 'applicability'),
      requirements: facetEntries(spec.requirements.map((r) => r.facet), nodes.requirements, 'requirements',
        spec.requirements.map((r) => r.optionality ?? 'required')),
    })),
  };
}

function fullView(doc: StudioDocument, specIds?: readonly string[]) {
  return {
    info: doc.ids.info,
    specifications: selected(doc, specIds).map(({ spec, nodes }) => ({ nodes, specification: spec })),
  };
}

function plainView(doc: StudioDocument, specIds?: readonly string[]): string {
  const lines: string[] = [`IDS "${doc.ids.info.title}"`];
  for (const { spec } of selected(doc, specIds)) {
    lines.push(`- ${spec.name} (${spec.ifcVersions.join(', ')}, ${cardinality(spec)})`);
    for (const f of spec.applicability.facets) lines.push(`  applies to: ${facetLine(f, 'applicability')}`);
    for (const r of spec.requirements) lines.push(`  requires: ${facetLine(r.facet, 'requirements', r.optionality ?? 'required')}`);
  }
  return lines.join('\n');
}

const idsRead = defineTool<{ view: View; specIds?: string[] }, AgentToolContext>({
  name: 'ids_read', group: 'ids', strict: true, readOnly: true,
  description: 'Read the working IDS document. view "summary" lists specifications and facets with their node ids; "full" returns the IDS content of the selected specifications; "plain" returns plain-language sentences.',
  inputSchema: objectSchema({
    view: { enum: ['summary', 'full', 'plain'] },
    specIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to these specification ids.' },
  }, ['view']),
  run(input, ctx) {
    const doc = ctx.sandbox.doc;
    if (input.view === 'plain') return success('plain view', { text: plainView(doc, input.specIds) });
    if (input.view === 'full') return success('full view', fullView(doc, input.specIds));
    return success('summary view', summarizeDocument(doc, input.specIds));
  },
});

export const IDS_READ_TOOLS: readonly IdsAgentTool[] = [idsRead];
