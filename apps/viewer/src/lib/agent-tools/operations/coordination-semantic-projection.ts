/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useSemanticSession } from '@/lib/semantic/session';
import { previewProjection, applyProjection, PROJECTION_MAPPINGS, type ProjectionPlan } from '@/lib/semantic/projection';
import { resolveResource, selectionTargets, relatedResources } from '@/lib/semantic/resolver';
import { liveEntities, selectResources } from '@/lib/semantic/viewer';
import { coordination, modelCoordination, idSchema } from './coordination-common';
const plans = new Map<string, { plan: ProjectionPlan; dataVersion: number; revisions: ReadonlyMap<string, string> }>();
export const coordinationSemanticProjectionOperations = [
  coordination<{ resource_id: string; model_scope: string; select: boolean }>('semantic.resolveResource', 'Resolve an exact native linked record with the configured identity strategy, inspect its relationships, and optionally select its native ownership targets in one explicit model scope.', ['read', 'view'], {
    type: 'object', properties: { resource_id: { type: 'string', minLength: 1, maxLength: 2000 }, model_scope: { type: 'string', minLength: 1, maxLength: 200 }, select: { type: 'boolean' } }, required: ['resource_id', 'model_scope', 'select'], additionalProperties: false,
  }, (i, c) => {
    if (!c.host.models().some(model => model.id === i.model_scope)) throw new Error('Unknown native model scope.');
    const s = useSemanticSession.getState(), resources = s.document?.resources ?? [], resource = resources.find(resource => resource.id === i.resource_id); if (!resource) throw new Error('Unknown native linked record.');
    const resolution = resolveResource(resource, liveEntities(), s.revisions, i.model_scope);
    const selected = i.select ? c.commit(() => selectResources(resolution.status === 'resolved' ? [resource] : selectionTargets(resources, resource), s.revisions, i.model_scope)) : null;
    return { resolution, related: relatedResources(resources, [resource.id]), selected };
  }),
  modelCoordination<{ resource_id: string; mapping_id: 'door-fire-rating' | 'wall-thermal-transmittance'; policy: 'error' | 'skip' | 'overwrite'; expected_data_version: number }>('semantic.prepareProjection', 'Prepare the exact native IFC property projection and provenance for a linked installation in the explicitly bound model. Returns an opaque review plan; no IFC mutation occurs.', ['read'], {
    type: 'object', properties: { resource_id: { type: 'string', minLength: 1, maxLength: 2000 }, mapping_id: { type: 'string', enum: ['door-fire-rating', 'wall-thermal-transmittance'] }, policy: { type: 'string', enum: ['error', 'skip', 'overwrite'] }, expected_data_version: { type: 'integer', minimum: 0 } }, required: ['resource_id', 'mapping_id', 'policy', 'expected_data_version'], additionalProperties: false,
  }, (i, c) => {
    const s = useSemanticSession.getState(); if (s.dataVersion !== i.expected_data_version || !s.document) throw new Error('Native semantic dataset changed or is absent.');
    const resource = s.document.resources.find(resource => resource.id === i.resource_id), product = s.document.resources.find(product => product.id === resource?.productId); if (!resource || !product) throw new Error('Projection requires a native installation and its linked product.');
    const plan = previewProjection({ mappingId: i.mapping_id, resource, product, revisions: s.revisions, source: s.document.source, profile: s.profile.id, profileVersion: s.profile.version, retrievedAt: s.retrievedAt, scope: c.model.id, policy: i.policy, unit: s.profile.fields[PROJECTION_MAPPINGS.find(mapping => mapping.id === i.mapping_id)!.field]?.unit });
    if (plan.ref.modelId !== c.model.id) throw new Error('Native projection resolved outside the explicitly bound model.'); const id = crypto.randomUUID(); if (plans.size >= 50) plans.delete(plans.keys().next().value!); plans.set(id, { plan, dataVersion: s.dataVersion, revisions: s.revisions });
    return { plan_id: id, target: plan.ref, GlobalId: plan.targetGlobalId, revision: plan.revision ?? null, property: `${plan.mapping.pset}.${plan.mapping.property}`, previous: plan.previous ?? null, value: plan.value, unit: plan.mapping.unit ?? null, policy: plan.policy, skip: plan.skip };
  }),
  modelCoordination('semantic.applyProjection', 'Apply one exact prepared native projection through the canonical mutate adapter in its single native undo batch. Native permission, property conflict, model identity and revision guards are rechecked at commit.', ['model'], idSchema, (i, c) => {
    const prepared = plans.get(i.id), s = useSemanticSession.getState(); if (!prepared || prepared.plan.ref.modelId !== c.model.id || prepared.dataVersion !== s.dataVersion || prepared.revisions !== s.revisions) throw new Error('Native projection review is absent, stale or bound to another model.');
    return c.commit(() => { applyProjection(prepared.plan, s.revisions, c.model.id); plans.delete(i.id); return { applied: !prepared.plan.skip, skipped: prepared.plan.skip, plan_id: i.id }; });
  }),
];
