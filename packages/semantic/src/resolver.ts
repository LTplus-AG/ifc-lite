/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GUID_PATTERN } from './types.js';
export { GUID_PATTERN } from './types.js';
export interface EntityAddress { modelId: string; expressId: number }
export interface LiveEntity extends EntityAddress { GlobalId: string }
export type Resolution = { status: 'resolved'; ref: EntityAddress } | { status: 'ambiguous'; candidates: EntityAddress[] }
  | { status: 'unmatched' | 'unscoped' | 'external' | 'invalid' };
export interface IdentityRecord { GlobalId?: unknown; modelRevision?: unknown; [key: string]: unknown }
export interface ResolverContext {
  entities: readonly LiveEntity[]; revisions: ReadonlyMap<string, string>; modelScope?: string;
}
export interface IdentityStrategy { id: string; resolve(record: IdentityRecord, context: ResolverContext): Resolution }
/** Generic revision identifiers are non-empty opaque strings; profiles may constrain them further. */
export function assertRevisionIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Revision identifier must be a non-empty string');
}

export const IFC_GLOBAL_ID_STRATEGY: IdentityStrategy = {
  id: 'ifc-global-id', resolve(record, { entities, revisions, modelScope }) {
    if (record.GlobalId === undefined) return { status: 'external' };
    if (typeof record.GlobalId !== 'string' || !new RegExp(GUID_PATTERN).test(record.GlobalId)
      || (record.modelRevision !== undefined && (typeof record.modelRevision !== 'string' || !record.modelRevision.trim()))) return { status: 'invalid' };
    const revisionModel = record.modelRevision ? revisions.get(String(record.modelRevision)) : undefined;
    if (record.modelRevision && !revisionModel) return { status: 'unscoped' };
    if (revisionModel && modelScope && revisionModel !== modelScope) return { status: 'unmatched' };
    const scope = revisionModel ?? modelScope;
    const unique = new Map<string, EntityAddress>();
    for (const entity of entities) if (entity.GlobalId === record.GlobalId && (!scope || scope === entity.modelId)) {
      unique.set(`${entity.modelId}:${entity.expressId}`, { modelId: entity.modelId, expressId: entity.expressId });
    }
    const candidates = [...unique.values()];
    return candidates.length === 1 ? { status: 'resolved', ref: candidates[0] } : candidates.length ? { status: 'ambiguous', candidates } : { status: 'unmatched' };
  },
};
/** Strategies are explicit: never try increasingly permissive fallbacks after a failed match. */
export class ResolverRegistry {
  private readonly strategies = new Map<string, IdentityStrategy>();
  constructor(strategies: readonly IdentityStrategy[] = [IFC_GLOBAL_ID_STRATEGY]) { strategies.forEach(strategy => this.register(strategy)); }
  register(strategy: IdentityStrategy): void {
    if (!strategy.id || this.strategies.has(strategy.id)) throw new Error('Resolver strategy id must be unique');
    this.strategies.set(strategy.id, strategy);
  }
  resolve(strategyId: string, record: IdentityRecord, context: ResolverContext): Resolution {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) throw new Error(`Unknown resolver strategy: ${strategyId}`);
    return strategy.resolve(record, context);
  }
  ids(): string[] { return [...this.strategies.keys()]; }
}
export function resolveResource(record: IdentityRecord, entities: readonly LiveEntity[], revisions: ReadonlyMap<string, string>, modelScope?: string): Resolution {
  return IFC_GLOBAL_ID_STRATEGY.resolve(record, { entities, revisions, modelScope });
}
/** Portable association references semantic revision and IFC GlobalId, never express ids. */
export interface ResourceIdentityLink { resourceId: string; modelRevision: string; GlobalId: string }
export function createResourceLinkStrategy(links: readonly ResourceIdentityLink[], id = 'resource-links'): IdentityStrategy {
  const byResource = new Map<string, ResourceIdentityLink[]>();
  for (const link of links) {
    assertRevisionIdentifier(link.modelRevision);
    if (!link.resourceId || !link.modelRevision || !new RegExp(GUID_PATTERN).test(link.GlobalId)) throw new Error('Invalid portable resource identity link');
    byResource.set(link.resourceId, [...(byResource.get(link.resourceId) ?? []), { ...link }]);
  }
  return { id, resolve(record, context) {
    if (typeof record.id !== 'string') return { status: 'invalid' };
    const linked = byResource.get(record.id);
    if (!linked) return { status: 'external' };
    // Several declared identities are alternatives, not permission to choose the first.
    const resolved = linked.map(link => IFC_GLOBAL_ID_STRATEGY.resolve({ GlobalId: link.GlobalId, modelRevision: link.modelRevision }, context));
    if (resolved.some(result => result.status === 'invalid' || result.status === 'unscoped')) return { status: 'unscoped' };
    const candidates = new Map<string, EntityAddress>();
    for (const result of resolved) {
      const refs = result.status === 'resolved' ? [result.ref] : result.status === 'ambiguous' ? result.candidates : [];
      refs.forEach(ref => candidates.set(`${ref.modelId}:${ref.expressId}`, ref));
    }
    const refs = [...candidates.values()];
    return refs.length === 1 ? { status: 'resolved', ref: refs[0] } : refs.length ? { status: 'ambiguous', candidates: refs } : { status: 'unmatched' };
  } };
}
/** Map named domain identity fields explicitly, retaining the same safe IFC strategy. */
export function createProfileMappingStrategy(id: string, fields: { GlobalId: string; modelRevision?: string }): IdentityStrategy {
  if (!id || !fields.GlobalId) throw new Error('Profile identity mapping needs a strategy id and GlobalId field');
  return { id, resolve(record, context) {
    return IFC_GLOBAL_ID_STRATEGY.resolve({ GlobalId: record[fields.GlobalId], modelRevision: fields.modelRevision ? record[fields.modelRevision] : undefined }, context);
  } };
}
