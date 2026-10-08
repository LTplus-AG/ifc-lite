/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sanitizeSource, type SemanticResource, type EntityAddress } from '@ifc-lite/semantic';
import { validatePropertyDataType } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { useSemanticSession } from './session';
import { getModelForRef } from '@/sdk/adapters/model-compat';
import { mutationPermission } from '@/store/mutation-permission';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { createMutateAdapter } from '@/sdk/adapters/mutate-adapter';
import { liveEntities } from './viewer';
import { resolveResource } from './resolver';

export interface ProjectionMapping {
  id: string; version: string; field: string; classes: readonly string[]; pset: string; property: string;
  unit?: string; dataType: string; convert: (value: unknown, unit?: string) => string | number;
}
export const PROJECTION_MAPPINGS: readonly ProjectionMapping[] = [
  { id: 'door-fire-rating', version: '1', field: 'fireRating', classes: ['IfcDoor'], pset: 'Pset_DoorCommon', property: 'FireRating', dataType: 'IfcLabel',
    convert(value) { if (typeof value !== 'string' || !value.trim()) throw new Error('FireRating requires a non-empty declaration'); return value; } },
  { id: 'wall-thermal-transmittance', version: '1', field: 'thermalTransmittance', classes: ['IfcWall', 'IfcWallStandardCase'],
    pset: 'Pset_WallCommon', property: 'ThermalTransmittance', dataType: 'IfcThermalTransmittanceMeasure', unit: 'W/(m2.K)',
    convert(value, unit = 'W/(m2.K)') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('ThermalTransmittance requires a finite non-negative number');
      if (unit !== 'W/(m2.K)' && unit !== 'mW/(m2.K)') throw new Error('Unsupported thermal transmittance unit');
      return unit === 'mW/(m2.K)' ? value / 1000 : value;
    } },
];
export type ConflictPolicy = 'overwrite' | 'skip' | 'error';
export interface ProjectionPlan {
  mapping: ProjectionMapping; resource: SemanticResource; product: SemanticResource; ref: EntityAddress;
  source: string; profile: string; profileVersion: string; retrievedAt?: string; revision?: string; sourceUnit?: string;
  value: string | number; previous: string | number | boolean | null | undefined; policy: ConflictPolicy; skip: boolean;
  mutationVersion: number; modelIdentity: object; targetGlobalId: string; strategy: string;
}
function previousValue(ref: EntityAddress, mapping: ProjectionMapping) {
  return createQueryAdapter(useViewerStore).properties(ref).find(pset => pset.name === mapping.pset)
    ?.properties.find(property => property.name === mapping.property)?.value;
}
export function previewProjection(input: {
  mappingId: string; resource: SemanticResource; product: SemanticResource; revisions: ReadonlyMap<string, string>;
  source: string; profile: string; profileVersion: string; retrievedAt?: string; scope?: string; unit?: string; policy?: ConflictPolicy;
}): ProjectionPlan {
  const permission = mutationPermission(useViewerStore.getState());
  if (!permission.allowed) throw new Error(`Projection denied: ${permission.reason}`);
  const mapping = PROJECTION_MAPPINGS.find(candidate => candidate.id === input.mappingId);
  if (!mapping) throw new Error('Unknown projection mapping');
  const resolution = resolveResource(input.resource, liveEntities(), input.revisions, input.scope);
  if (resolution.status !== 'resolved' || input.resource.productId !== input.product.id) throw new Error('Projection requires one resolved installation and its product');
  const entity = createQueryAdapter(useViewerStore).entityData(resolution.ref);
  if (!entity || !mapping.classes.includes(entity.type)) throw new Error(`Mapping applies to ${mapping.classes.join(', ')}`);
  const value = mapping.convert(input.product[mapping.field], input.unit);
  validatePropertyDataType(value, mapping.dataType);
  const settings = useSemanticSession.getState();
  const modelIdentity = getModelForRef(useViewerStore.getState(), resolution.ref.modelId)?.ifcDataStore;
  if (!modelIdentity) throw new Error('Projection target model is no longer loaded');
  const linkedRevision = settings.strategy === 'resource-links' ? settings.links.find(link => link.resourceId === input.resource.id && link.GlobalId === entity.globalId && input.revisions.get(link.modelRevision) === resolution.ref.modelId)?.modelRevision : undefined;
  const revisionValue = settings.strategy === 'profile-fields' ? input.resource[settings.identityFields.modelRevision ?? 'modelRevision'] : input.resource.modelRevision;
  const previous = previousValue(resolution.ref, mapping); const policy = input.policy ?? 'error';
  const conflict = previous !== undefined && previous !== null && previous !== value;
  if (conflict && policy === 'error') throw new Error('Target property conflicts with the declaration; choose overwrite or skip explicitly');
  return { mapping, resource: { ...input.resource }, product: { ...input.product }, ref: resolution.ref,
    source: sanitizeSource(input.source), profile: input.profile, profileVersion: input.profileVersion, retrievedAt: input.retrievedAt,
    modelIdentity, targetGlobalId: entity.globalId, strategy: settings.strategy,
    revision: linkedRevision ?? (typeof revisionValue === 'string' ? revisionValue : undefined),
    sourceUnit: input.unit, value, previous, policy, skip: conflict && policy === 'skip', mutationVersion: useViewerStore.getState().mutationVersion };
}
function assertCurrentProjection(plan: ProjectionPlan, revisions: ReadonlyMap<string, string>, scope?: string): void {
  const fresh = previewProjection({ mappingId: plan.mapping.id, resource: plan.resource, product: plan.product, revisions,
    source: plan.source, profile: plan.profile, profileVersion: plan.profileVersion, retrievedAt: plan.retrievedAt,
    scope, unit: plan.sourceUnit, policy: plan.policy });
  if (fresh.ref.modelId !== plan.ref.modelId || fresh.ref.expressId !== plan.ref.expressId || fresh.previous !== plan.previous
    || fresh.value !== plan.value || fresh.mutationVersion !== plan.mutationVersion || fresh.modelIdentity !== plan.modelIdentity
    || fresh.targetGlobalId !== plan.targetGlobalId || fresh.revision !== plan.revision || fresh.strategy !== plan.strategy) throw new Error('Projection preview is stale; preview again');
 }

/** Validate every plan before writing; the complete reviewed batch is one native undo step. */
export function applyProjections(plans: readonly ProjectionPlan[], revisions: ReadonlyMap<string, string>, scope?: string): void {
  const targets = new Set<string>();
  for (const plan of plans) {
    assertCurrentProjection(plan, revisions, scope);
    if (plan.skip) continue;
    const target = JSON.stringify([plan.ref.modelId, plan.ref.expressId, plan.mapping.pset, plan.mapping.property]);
    if (targets.has(target)) throw new Error('Multiple projections target the same IFC property; choose one');
    targets.add(target);
  }
  const mutation = createMutateAdapter(useViewerStore); const label = 'Semantic property projection';
  mutation.batchBegin(label);
  try {
    for (const plan of plans) {
      if (plan.skip) continue;
    mutation.setProperty(plan.ref, plan.mapping.pset, plan.mapping.property, plan.value, plan.mapping.dataType);
    const provenance = { Source: plan.source, Profile: plan.profile, ProfileVersion: plan.profileVersion,
      ProductId: plan.product.id, InstallationId: plan.resource.id, GlobalId: plan.targetGlobalId, IdentityStrategy: plan.strategy,
      Mapping: plan.mapping.id, MappingVersion: plan.mapping.version, ModelRevision: plan.revision,
      RetrievedAt: plan.retrievedAt, ProjectedAt: new Date().toISOString(), SemanticProperty: plan.mapping.field,
      TargetProperty: `${plan.mapping.pset}.${plan.mapping.property}`, Unit: plan.mapping.unit,
      EvidenceKind: 'Source declaration' };
    for (const [key, value] of Object.entries(provenance)) if (value !== undefined) mutation.setProperty(plan.ref, 'Pset_SemanticProjection', key, value, 'IfcText');
    }
  } finally { mutation.batchEnd(label); }
}

/** Single-record UI uses the same native batch path. */
export function applyProjection(plan: ProjectionPlan, revisions: ReadonlyMap<string, string>, scope?: string): void {
  applyProjections([plan], revisions, scope);
}
