/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IFC_GLOBAL_ID_STRATEGY, createResourceLinkStrategy, createProfileMappingStrategy, createResourceUriStrategy, DEFAULT_RESOURCE_URI_CONFIG,
  type IdentityStrategy, type LiveEntity, type ResourceUriIdentityConfig, type IdentityRecord, type ResolverContext, type Resolution, type ResourceIdentityLink } from '@ifc-lite/semantic';
export interface IdentityFields { GlobalId: string; modelRevision?: string }
export interface ResolverSettings { strategy: string; links: readonly ResourceIdentityLink[]; identityFields?: IdentityFields; uriConfig?: ResourceUriIdentityConfig }
function strategyFor(settings?: ResolverSettings): IdentityStrategy | undefined {
  if (!settings || settings.strategy === 'ifc-global-id') return IFC_GLOBAL_ID_STRATEGY;
  return settings.strategy === 'resource-links' ? createResourceLinkStrategy(settings.links)
    : settings.strategy === 'profile-fields' ? createProfileMappingStrategy('profile-fields', settings.identityFields ?? { GlobalId: 'GlobalId', modelRevision: 'modelRevision' })
      : settings.strategy === 'resource-uri' ? createResourceUriStrategy(settings.uriConfig ?? DEFAULT_RESOURCE_URI_CONFIG)
      : undefined;
}
export function resolveWithStrategy(resource: IdentityRecord, context: ResolverContext, settings?: ResolverSettings): Resolution {
  return strategyFor(settings)?.resolve(resource, context) ?? { status: 'invalid' };
}
/** One immutable snapshot and one strategy for a table render or batch action. */
export function createIndexedIdentityResolver(context: ResolverContext, settings?: ResolverSettings): (resource: IdentityRecord) => Resolution {
  const entitiesByGlobalId = new Map<string, LiveEntity[]>();
  for (const entity of context.entities) {
    const GlobalId = entity.GlobalId;
    const refs = entitiesByGlobalId.get(GlobalId);
    if (refs) refs.push(entity); else entitiesByGlobalId.set(GlobalId, [entity]);
  }
  const indexed = { ...context, entitiesByGlobalId };
  const strategy = strategyFor(settings);
  return resource => strategy?.resolve(resource, indexed) ?? { status: 'invalid' };
}
/** Only lexical string identity terms can identify IFC objects; do not coerce typed numbers. */
export function identityFromRow(row: Record<string, import('@ifc-lite/semantic').RdfBinding>, mapping: import('@ifc-lite/semantic').BindingMapping,
  settings?: ResolverSettings): IdentityRecord | undefined {
  const identity: IdentityRecord = Object.fromEntries(Object.entries(row).map(([key, term]) => [key, term.value]));
  for (const [field, column] of Object.entries(mapping)) if (row[column]) identity[field] = row[column].value;
  const id = row[mapping.id ?? 'id'];
  if (settings?.strategy === 'resource-links') return id?.type === 'uri' ? { ...identity, id: id.value } : undefined;
  if (settings?.strategy === 'resource-uri' && id?.type !== 'uri') return undefined;
  const fields = settings?.strategy === 'profile-fields' ? settings.identityFields ?? { GlobalId: 'GlobalId', modelRevision: 'modelRevision' } : { GlobalId: 'GlobalId', modelRevision: 'modelRevision' };
  const guid = row[mapping[fields.GlobalId] ?? fields.GlobalId];
  const revision = fields.modelRevision ? row[mapping[fields.modelRevision] ?? fields.modelRevision] : undefined;
  const stringTerm = (term: import('@ifc-lite/semantic').RdfBinding) => term.type === 'literal' && !term['xml:lang'] && (!term.datatype || term.datatype === 'http://www.w3.org/2001/XMLSchema#string');
  if ((guid && !stringTerm(guid)) || (revision && revision.type !== 'uri' && !stringTerm(revision))) return undefined;
  identity[fields.GlobalId] = guid?.value;
  if (fields.modelRevision) identity[fields.modelRevision] = revision?.value;
  identity.id = id?.type === 'uri' ? id.value : undefined;
  return identity;
}
