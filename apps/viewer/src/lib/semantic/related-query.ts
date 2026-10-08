/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GUID_PATTERN, resourceUriForGlobalId, DEFAULT_RESOURCE_URI_CONFIG, assertIri, relatedResourceQuery, relatedIdentityQuery, type BindingMapping, type EntityAddress,
  type LiveEntity, type ProfileDefinition, type SemanticDocument, type SparqlResults } from '@ifc-lite/semantic';
import { resolveWithStrategy, identityFromRow, type ResolverSettings } from './resolver-context';
export interface RelatedQueryInput {
  selection: readonly EntityAddress[]; entities: readonly LiveEntity[]; revisions: ReadonlyMap<string, string>;
  mapping: BindingMapping; settings?: ResolverSettings; profile: ProfileDefinition; document?: SemanticDocument; results?: SparqlResults;
}
/** Prefer known semantic subjects, then discover unknown subjects by explicit profile identity predicate. */
export function queryForSelection(input: RelatedQueryInput): string {
  const selected = (ref: EntityAddress) => input.selection.some(candidate => candidate.modelId === ref.modelId && candidate.expressId === ref.expressId);
  const ids = new Set<string>();
  const matched = new Set<string>();
  const mark = (ref: EntityAddress, id: string) => { ids.add(id); matched.add(`${ref.modelId}:${ref.expressId}`); };
  const known = (resolution: ReturnType<typeof resolveWithStrategy>, id: string) => {
    const refs = resolution.status === 'resolved' ? [resolution.ref] : input.settings?.strategy === 'resource-uri' && resolution.status === 'ambiguous' ? resolution.candidates : [];
    for (const ref of refs) if (selected(ref)) mark(ref, id);
  };
  for (const resource of input.document?.resources ?? []) {
    const resolution = resolveWithStrategy(resource, { entities: input.entities, revisions: input.revisions }, input.settings);
    known(resolution, resource.id);
  }
  for (const row of input.results?.rows ?? []) {
    const identity = identityFromRow(row, input.mapping, input.settings);
    if (!identity || typeof identity.id !== 'string') continue;
    const resolution = resolveWithStrategy(identity, { entities: input.entities, revisions: input.revisions }, input.settings);
    known(resolution, identity.id);
  }
  if (input.settings?.strategy === 'resource-links') {
    for (const link of input.settings.links) {
      const resolution = resolveWithStrategy({ id: link.resourceId }, { entities: input.entities, revisions: input.revisions }, input.settings);
      if (resolution.status === 'resolved' && selected(resolution.ref)) mark(resolution.ref, link.resourceId);
    }
    if (!ids.size) throw new Error('No explicit resource links resolve to the current IFC selection');
  }
  if (input.settings?.strategy === 'resource-uri') {
    const config = input.settings.uriConfig ?? DEFAULT_RESOURCE_URI_CONFIG;
    if (!input.selection.length) throw new Error('Select an IFC entity to retrieve related records');
    for (const entity of input.entities.filter(selected)) if (!matched.has(`${entity.modelId}:${entity.expressId}`)) ids.add(resourceUriForGlobalId(entity.GlobalId, config));
    if (!ids.size) throw new Error('Selected IFC entities are no longer available');
  }
  if (ids.size) return relatedResourceQuery([...ids]);
  const guidField = input.settings?.strategy === 'profile-fields' ? input.settings.identityFields?.GlobalId ?? 'GlobalId' : 'GlobalId';
  const predicate = input.profile.fields[guidField]?.iri;
  if (!predicate) throw new Error('Profile has no configured GlobalId identity predicate');
  assertIri(predicate);
  const guids = [...new Set(input.entities.filter(selected).map(entity => entity.GlobalId).filter(guid => new RegExp(GUID_PATTERN).test(guid)))];
  if (!guids.length || guids.length > 5000) throw new Error('Select an IFC entity with a valid GlobalId to retrieve related records');
  return relatedIdentityQuery(predicate, guids);
}
