/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IdentityRecord, ResolverContext } from '@ifc-lite/semantic';
import { resolveWithStrategy, type ResolverSettings } from './resolver-context';
import { useSemanticSession } from './session';
export function resolveResource(resource: IdentityRecord, entities: ResolverContext['entities'], revisions: ReadonlyMap<string, string>, modelScope?: string, settings: ResolverSettings = useSemanticSession.getState()) {
  return resolveWithStrategy(resource, { entities, revisions, modelScope }, settings);
}
import type { SemanticResource } from './types';
/** Selection follows ownership links, rather than the whole connected building. */
export function selectionTargets(resources: readonly SemanticResource[], resource: SemanticResource): SemanticResource[] {
  if (resource.type === 'Installation') return [resource];
  if (resource.type === 'Product') return resources.filter(record => record.type === 'Installation' && record.productId === resource.id);
  if (resource.type === 'Passport') {
    const product = resources.find(record => record.id === resource.productId);
    return product?.type === 'Product' ? resources.filter(record => record.type === 'Installation' && record.productId === product.id) : [];
  }
  if (resource.type === 'Inspection') return resources.filter(record => record.type === 'Installation' && record.id === resource.installationId);
  const buildingId = resource.type === 'Building' ? resource.id : resource.buildingId;
  return resources.filter(record => record.type === 'Installation' && record.buildingId === buildingId);
}
/** Traverse outgoing and incoming links iteratively, retaining non-IFC relationships. */
export function relatedResources(resources: readonly SemanticResource[], startIds: Iterable<string>): SemanticResource[] {
  if (resources.length > 5000) throw new Error('Related records exceed the pilot limit');
  const links = ['buildingId', 'productId', 'passportId', 'installationId', 'replacesId', 'evidenceId'] as const;
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => { const set = adjacency.get(a) ?? new Set<string>(); set.add(b); adjacency.set(a, set); };
  for (const resource of resources) for (const key of links) {
    const target = resource[key];
    if (typeof target === 'string' && byId.has(target)) { connect(resource.id, target); connect(target, resource.id); }
  }
  const pending = [...startIds]; const seen = new Set<string>();
  while (pending.length && seen.size < 5000) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id); pending.push(...(adjacency.get(id) ?? []));
  }
  return resources.filter(resource => seen.has(resource.id));
}
