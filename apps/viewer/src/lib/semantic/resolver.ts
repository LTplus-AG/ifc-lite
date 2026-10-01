/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GUID_PATTERN } from './profile';
import type { LiveEntity, Resolution, SemanticResource } from './types';

/** Revision identifiers are explicitly associated with current loaded model ids. */
export function resolveResource(resource: SemanticResource, entities: readonly LiveEntity[],
  revisions: ReadonlyMap<string, string>, modelScope?: string): Resolution {
  if (!resource.GlobalId) return { status: 'external' };
  if (!new RegExp(GUID_PATTERN).test(resource.GlobalId)) return { status: 'invalid' };
  const revisionModel = resource.modelRevision ? revisions.get(resource.modelRevision) : undefined;
  if (resource.modelRevision && !revisionModel) return { status: 'unscoped' };
  if (revisionModel && modelScope && revisionModel !== modelScope) return { status: 'unmatched' };
  const scope = revisionModel ?? modelScope;
  const candidates = entities.filter(entity => entity.GlobalId === resource.GlobalId && (!scope || entity.modelId === scope))
    .map(({ modelId, expressId }) => ({ modelId, expressId }));
  return candidates.length === 1 ? { status: 'resolved', ref: candidates[0] }
    : candidates.length ? { status: 'ambiguous', candidates } : { status: 'unmatched' };
}
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
    if (target && byId.has(target)) { connect(resource.id, target); connect(target, resource.id); }
  }
  const pending = [...startIds]; const seen = new Set<string>();
  while (pending.length && seen.size < 5000) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id); pending.push(...(adjacency.get(id) ?? []));
  }
  return resources.filter(resource => seen.has(resource.id));
}
