/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ResolverRegistry, IFC_GLOBAL_ID_STRATEGY, createResourceLinkStrategy, createProfileMappingStrategy,
  type IdentityRecord, type ResolverContext, type Resolution, type ResourceIdentityLink } from '@ifc-lite/semantic';
export interface IdentityFields { GlobalId: string; modelRevision?: string }
export interface ResolverSettings { strategy: string; links: readonly ResourceIdentityLink[]; identityFields?: IdentityFields }
export function resolveWithStrategy(resource: IdentityRecord, context: ResolverContext, settings?: ResolverSettings): Resolution {
  if (!settings || settings.strategy === 'ifc-global-id') return IFC_GLOBAL_ID_STRATEGY.resolve(resource, context);
  const strategy = settings.strategy === 'resource-links' ? createResourceLinkStrategy(settings.links)
    : settings.strategy === 'profile-fields' ? createProfileMappingStrategy('profile-fields', settings.identityFields ?? { GlobalId: 'GlobalId', modelRevision: 'modelRevision' })
      : undefined;
  if (!strategy) return { status: 'invalid' };
  return new ResolverRegistry([strategy]).resolve(strategy.id, resource, context);
}
/** Only lexical string identity terms can identify IFC objects; do not coerce typed numbers. */
export function identityFromRow(row: Record<string, import('@ifc-lite/semantic').RdfBinding>, mapping: import('@ifc-lite/semantic').BindingMapping,
  settings?: ResolverSettings): IdentityRecord | undefined {
  const identity: IdentityRecord = Object.fromEntries(Object.entries(row).map(([key, term]) => [key, term.value]));
  for (const [field, column] of Object.entries(mapping)) if (row[column]) identity[field] = row[column].value;
  const id = row[mapping.id ?? 'id'];
  if (settings?.strategy === 'resource-links') return id?.type === 'uri' ? { ...identity, id: id.value } : undefined;
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
