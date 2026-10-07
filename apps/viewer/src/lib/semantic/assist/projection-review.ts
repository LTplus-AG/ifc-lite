/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProfileDefinition, SemanticDocument } from '@ifc-lite/semantic';
import { PROJECTION_MAPPINGS, applyProjections, previewProjection, type ProjectionPlan } from '../projection';
import type { ProposedProjection, SemanticProjectionProposal } from './projection-proposal';

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
  try {
    applyProjections(plans, revisions);
    return plans.map(plan => ({ plan }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return plans.map(plan => ({ plan, error: message }));
  }
}
