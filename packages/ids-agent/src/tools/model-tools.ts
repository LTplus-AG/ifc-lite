/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model tools (`06-ai-agent.md` §5): what the loaded IFC models contain,
 * answered by the host's `ModelBridge` (the model-loop worker). Registered
 * only when the host provides a bridge, so a run without models never offers
 * them. Results are capped here as well as in the bridge: model strings are
 * data the model reads, not instructions, and they are never long.
 */

import type { IDSFacet } from '@ifc-lite/ids';
import { facetFromDraft, type FacetDraft } from '@ifc-lite/ids-authoring';
import { capText, clampLimit, objectSchema, IFC_VERSIONS, type AgentToolContext, type IdsAgentTool } from './context.js';
import { agentOpSchema } from './op-schema.js';
import { defineTool, failure, success, type ToolOutcome } from './registry.js';

function bridge(ctx: AgentToolContext) {
  if (!ctx.model) throw new Error('No model is loaded.');
  return ctx.model;
}

function specFacets(ctx: AgentToolContext, specId: string): { applicability: IDSFacet[]; requirements: IDSFacet[] } | null {
  const index = ctx.sandbox.doc.nodes.specs.findIndex((s) => s.id === specId);
  if (index < 0) return null;
  const spec = ctx.sandbox.doc.ids.specifications[index];
  return { applicability: spec.applicability.facets, requirements: spec.requirements.map((r) => r.facet) };
}

const stats = defineTool<Record<string, never>, AgentToolContext>({
  name: 'model_stats', group: 'model', strict: true, readOnly: true,
  description: 'Loaded IFC models: schema, element count, most frequent classes and length unit.',
  inputSchema: objectSchema({}, []),
  async run(_input, ctx) {
    const models = await bridge(ctx).stats(ctx.signal);
    return success(`${models.length} models`, {
      models: models.map((m) => ({ ...m, classes: m.classes.slice(0, 30) })),
    });
  },
});

const count = defineTool<{ specId?: string; applicability?: FacetDraft[]; ifcVersions?: ('IFC2X3' | 'IFC4' | 'IFC4X3_ADD2')[] }, AgentToolContext>({
  name: 'model_count', group: 'model', strict: false, readOnly: true,
  description: 'Funnel counts in the loaded models: how many elements remain after each applicability facet. Give a specId (and get its requirement pass/fail preview too) or facets as drafts.',
  inputSchema: objectSchema({
    specId: { type: 'string' },
    applicability: { type: 'array', items: { $ref: '#/$defs/FacetDraft' } },
    ifcVersions: { type: 'array', items: { enum: IFC_VERSIONS } },
  }, []),
  defs: agentOpSchema().defs,
  async run(input, ctx): Promise<ToolOutcome> {
    let query: { applicability: IDSFacet[]; requirements?: IDSFacet[] };
    if (input.specId) {
      const facets = specFacets(ctx, input.specId);
      if (!facets) return failure('unknown spec', { error: `No specification has id "${input.specId}".` }, [`COUNT:${input.specId}`]);
      query = facets;
    } else if (input.applicability && input.applicability.length > 0) {
      query = { applicability: input.applicability.map(facetFromDraft) };
    } else {
      return failure('nothing to count', { error: 'Give a specId or at least one applicability facet.' }, ['COUNT:empty']);
    }
    const counts = await bridge(ctx).count({ ...query, ...(input.ifcVersions ? { ifcVersions: input.ifcVersions } : {}) }, ctx.signal);
    return success(`${counts.applicable} applicable`, { ...counts, ...(counts.applicable === 0 ? { warning: 'No element matches; check the applicability against model_stats before finishing.' } : {}) });
  },
});

const distinct = defineTool<{ entity?: string; propertySet: string; property: string; limit?: number }, AgentToolContext>({
  name: 'model_distinct_values', group: 'model', strict: true, readOnly: true,
  description: 'Distinct values of one property in the loaded models (optionally for one entity), with counts. Capped; long strings are truncated.',
  inputSchema: objectSchema({
    entity: { type: 'string' }, propertySet: { type: 'string', minLength: 1 }, property: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, description: 'At most 50.' },
  }, ['propertySet', 'property']),
  async run(input, ctx) {
    const limit = clampLimit(input.limit, 20, 50);
    const result = await bridge(ctx).distinctValues({ ...input, limit }, ctx.signal);
    const values = result.values.slice(0, limit).map((v) => ({ value: capText(v.value, 120), count: v.count }));
    return success(`${values.length} values of ${input.propertySet}.${input.property}`, {
      values, truncated: result.truncated || result.values.length > limit || values.some((v, i) => v.value !== result.values[i].value),
    });
  },
});

const infer = defineTool<{ selection?: string; entity?: string; threshold?: number }, AgentToolContext>({
  name: 'model_infer', group: 'model', strict: true, readOnly: true,
  description: 'Infer applicability and requirement facets from elements: the current selection (selection: "current") or every element of an entity. Each candidate comes with how many examples have it.',
  inputSchema: objectSchema({
    selection: { enum: ['current'] }, entity: { type: 'string' },
    threshold: { type: 'number', minimum: 0, description: 'Share of examples (0..1) that must have a facet; default 1.' },
  }, []),
  async run(input, ctx) {
    if (!input.selection && !input.entity) return failure('nothing to infer from', { error: 'Give selection "current" or an entity.' }, ['INFER:empty']);
    const threshold = input.threshold === undefined ? 1 : Math.min(1, input.threshold);
    const result = await bridge(ctx).infer({ ...(input.selection ? { selection: input.selection } : {}), ...(input.entity ? { entity: input.entity } : {}), threshold }, ctx.signal);
    return success(`${result.candidates.length} candidates`, { candidates: result.candidates.slice(0, 40), sampled: result.sampled });
  },
});

const coverage = defineTool<Record<string, never>, AgentToolContext>({
  name: 'model_coverage', group: 'model', strict: true, readOnly: true,
  description: 'IFC classes in the loaded models that no specification of the working document applies to, by element count.',
  inputSchema: objectSchema({}, []),
  async run(_input, ctx) {
    const applicabilities = ctx.sandbox.doc.ids.specifications.map((s) => s.applicability.facets);
    const classes = await bridge(ctx).coverage({ applicabilities }, ctx.signal);
    return success(`${classes.length} ungoverned classes`, { ungoverned: classes.slice(0, 30) });
  },
});

export const MODEL_TOOLS: readonly IdsAgentTool[] = [stats, count, distinct, infer, coverage];
