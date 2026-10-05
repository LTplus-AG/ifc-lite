/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProfileDefinition, SemanticDocument } from '@ifc-lite/semantic';
import { PROJECTION_MAPPINGS, applyProjection, previewProjection, type ConflictPolicy, type ProjectionPlan } from '../projection';
import { onlyKeys, parseEnvelope, record, text } from './proposal-common';

/** Which linked-record field to project onto which installation's element, through the native projection service. */
export interface ProposedProjection { resource: string; field: string; mapping?: string; policy: ConflictPolicy }
export interface SemanticProjectionProposal { version: 1; kind: 'semantic.projection'; title: string; rationale?: string; projections: ProposedProjection[] }

export function parseSemanticProjection(answer: string): SemanticProjectionProposal {
  const value = parseEnvelope(answer, 'semantic.projection', ['rationale', 'projections']);
  if (value.rationale !== undefined && !text(value.rationale, 1000)) throw new Error('The rationale must be text');
  if (!Array.isArray(value.projections) || !value.projections.length || value.projections.length > 200) throw new Error('A projection proposal needs 1 to 200 projections');
  const keys = new Set<string>();
  const projections = value.projections.map((item, index): ProposedProjection => {
    const at = `Projection ${index + 1}`;
    if (!record(item)) throw new Error(`${at} is not an object`);
    onlyKeys(item, ['resource', 'field', 'mapping', 'policy'], at);
    if (!text(item.resource, 2000)) throw new Error(`${at} must name the installation record id`);
    if (!text(item.field, 120)) throw new Error(`${at} must name the record field to project`);
    if (item.mapping !== undefined && !text(item.mapping, 120)) throw new Error(`${at} mapping must be a native mapping id`);
    const policy = item.policy ?? 'error';
    if (policy !== 'error' && policy !== 'skip' && policy !== 'overwrite') throw new Error(`${at} policy must be error, skip or overwrite`);
    const key = `${item.resource}\u0000${item.field}`;
    if (keys.has(key)) throw new Error(`${at} repeats an earlier projection`);
    keys.add(key);
    return { resource: item.resource, field: item.field, ...(item.mapping === undefined ? {} : { mapping: item.mapping as string }), policy };
  });
  return { version: 1, kind: 'semantic.projection', title: (value.title as string).trim(),
    ...(value.rationale === undefined ? {} : { rationale: value.rationale as string }), projections };
}

export type ProjectionRow = { projection: ProposedProjection } & ({ status: 'ready'; plan: ProjectionPlan } | { status: 'refused'; reason: string });

/** Each row is previewed by the existing projection service; its refusal reason is shown verbatim. */
export function previewSemanticProjection(proposal: SemanticProjectionProposal, input: {
  document: SemanticDocument | undefined; profile: ProfileDefinition; revisions: ReadonlyMap<string, string>; retrievedAt?: string;
}): ProjectionRow[] {
  return proposal.projections.map(projection => {
    try {
      if (!input.document) throw new Error('No linked records are loaded');
      const resource = input.document.resources.find(candidate => candidate.id === projection.resource);
      if (!resource) throw new Error('The installation record is not in the loaded records');
      const product = input.document.resources.find(candidate => candidate.id === resource.productId);
      if (!product) throw new Error('The installation has no loaded product record');
      const candidates = PROJECTION_MAPPINGS.filter(mapping => mapping.field === projection.field && (!projection.mapping || mapping.id === projection.mapping));
      if (candidates.length !== 1) throw new Error(candidates.length ? 'Several native mappings project this field; name one' : 'No native projection mapping exists for this field');
      const plan = previewProjection({ mappingId: candidates[0].id, resource, product, revisions: input.revisions,
        source: input.document.source, profile: input.profile.id, profileVersion: input.profile.version, retrievedAt: input.retrievedAt,
        policy: projection.policy, unit: input.profile.fields[candidates[0].field]?.unit });
      return { projection, status: 'ready', plan };
    } catch (error) {
      return { projection, status: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Apply approved plans through the native service; each re-previews and refuses a stale plan. */
export function applySemanticProjections(plans: readonly ProjectionPlan[], revisions: ReadonlyMap<string, string>): Array<{ plan: ProjectionPlan; error?: string }> {
  return plans.map(plan => {
    try { applyProjection(plan, revisions); return { plan }; }
    catch (error) { return { plan, error: error instanceof Error ? error.message : String(error) }; }
  });
}
