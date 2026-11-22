/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { mutationPermission } from '@/store/mutation-permission';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { compareNativeAppearancePreview } from '@/lib/appearance/appearance-native-preview';
import { appearanceRevision, commitAppearance } from '@/lib/appearance/command';
import { createAppearancePlanner } from '@/lib/appearance/planner-worker-client';
import { prepareAppearanceSnapshot } from '@/lib/appearance/snapshot';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { prepareNativeAppearancePlan, stageNativeAppearancePreview } from '@/lib/appearance/prepare-native-preview';
import type { AppearanceRequest } from '@/lib/appearance/planner-types';
import type { AppearanceDraftSettings } from '@/lib/appearance/draft-types';
import type { AppearanceAssetOwner } from '@/lib/appearance/assets';
import type { ToolHost } from '../types';
import { entityExists } from '../refs';
import { operation, referenceSchema, type OperationContext } from './contract';
import { metadata, idSchema, checkpoint } from './analytics-common';
import { invalidInput, stale, unavailable } from './refusals';
import { mutationRefusal } from './mutation-refusal';
export interface Settings extends AppearanceDraftSettings { representationPolicy: 'preserve' | 'evaluatedOccurrence' }
export const settingsSchema: JSONSchemaType<Settings> = {
  type: 'object', properties: {
    representationPolicy: { type: 'string', enum: ['preserve', 'evaluatedOccurrence'] }, kind: { type: 'string', enum: ['existingUv', 'planar', 'box'] }, plane: { type: 'string', enum: ['xy', 'xz', 'yz'] },
    repeatU: { type: 'number', exclusiveMinimum: 0, maximum: 10000 }, repeatV: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
    tileWidth: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 }, tileHeight: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 }, tileDepth: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 },
    rotationDegrees: { type: 'number', minimum: -360, maximum: 360 }, offsetU: { type: 'number', minimum: -1e9, maximum: 1e9 }, offsetV: { type: 'number', minimum: -1e9, maximum: 1e9 }, offsetW: { type: 'number', minimum: -1e9, maximum: 1e9 }, repeatS: { type: 'boolean' }, repeatT: { type: 'boolean' },
  }, required: ['representationPolicy', 'kind', 'plane', 'repeatU', 'repeatV', 'tileWidth', 'tileHeight', 'tileDepth', 'rotationDegrees', 'offsetU', 'offsetV', 'offsetW', 'repeatS', 'repeatT'], additionalProperties: false,
};
type Prepared = Awaited<ReturnType<typeof prepareNativeAppearancePlan>>;
type Staged = ReturnType<typeof stageNativeAppearancePreview>;
interface Candidate { modelId: string; revision: string; renderer: Renderer; prepared: Prepared; stage: Omit<Staged, 'session'> & { session: Staged['session'] | null }; owner: AppearanceAssetOwner; applying?: boolean }
const candidates = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(host: ToolHost) {
  let value = candidates.get(host);
  if (!value) { const map = new Map<string, Candidate>(); value = map; candidates.set(host, map); host.lifetimeSignal?.addEventListener('abort', () => { for (const candidate of map.values()) { if (candidate.applying) continue; try { release(candidate); } catch (error) { console.error('[appearance operations] preview cleanup failed', error); } } map.clear(); }); }
  return value;
}
function release(candidate: Candidate) { try { candidate.stage.session?.cancel(); } finally { appearanceAssets.releaseOwner(candidate.owner); } }
function gate(modelId: string) { const permission = mutationPermission(useViewerStore.getState(), modelId); if (!permission.allowed) throw mutationRefusal(permission.reason, modelId); if (useViewerStore.getState().collabRoomId) throw unavailable('Leave the shared room before changing appearance.'); }
/** Shared native Compare seam for the appearance-owned operation module. */
export function compareAnalyticsAppearancePreview(host: ToolHost, id: string, modelId: string, original: boolean) {
  const candidate = owned(host).get(id);
  if (!candidate || candidate.modelId !== modelId) throw invalidInput('unknown-target', 'Unknown appearance candidate for this host/model.');
  if (candidate.applying) throw unavailable('The native appearance candidate is being applied.');
  if (appearanceRevision(modelId) !== candidate.revision || getGlobalRenderer() !== candidate.renderer) throw stale('Appearance model or renderer changed. Prepare a new candidate.');
  candidate.stage.session = compareNativeAppearancePreview(candidate.renderer, candidate.stage.groups, candidate.stage.session, original);
  return { preview_visible: !original, model_id: modelId, preview_token: id };
}
/** Shared candidate preparation; native face-mask services supply already validated requests. */
export async function prepareAnalyticsAppearanceCandidate(i: { source_id: string; express_ids: number[]; settings: Settings }, c: OperationContext, faceMasks?: AppearanceRequest['faceMasks']) {
    gate(c.model.id); if (i.express_ids.some(id => !entityExists(c.model, id))) throw invalidInput('unknown-target', 'An appearance target is missing from the exact target model.');
    const selectedSource = useViewerStore.getState().appearanceSources.find(source => source.id === i.source_id);
    if (!selectedSource) throw invalidInput('unknown-target', 'Unknown native appearance source. Register an image/PDF through the native source workflow first.');
    const renderer = getGlobalRenderer(); if (!renderer) throw unavailable('Native appearance renderer is unavailable.');
    const owner: AppearanceAssetOwner = { kind: 'draft', id: crypto.randomUUID() }; const planner = createAppearancePlanner();
    const signal = c.signal ?? new AbortController().signal; let adopted = false;
    try {
      checkpoint(c); const snapshot = await prepareAppearanceSnapshot(null, c.model.id, i.express_ids, planner, signal);
      const prepared = await prepareNativeAppearancePlan({ snapshot, productIds: i.express_ids, sourceId: i.source_id, selectedSource, settings: i.settings, planner, owner, signal, faceMasks });
      if (!prepared.plan.items.length || prepared.plan.exclusions.length) throw unavailable(prepared.plan.exclusions.map(row => row.reason).join('; ') || 'No supported native appearance surfaces.');
      snapshot.validate(); gate(c.model.id); checkpoint(c);
      const map = owned(c.host);
      const token = crypto.randomUUID();
      if (getGlobalRenderer() !== renderer || useViewerStore.getState().appearanceSources.find(source => source.id === i.source_id) !== selectedSource)
        throw stale('The native renderer or source changed during preview preparation.');
      c.commit(() => {
        const replacements = [...map].filter(([, candidate]) => candidate.modelId === c.model.id);
        if (map.size - replacements.length >= 16) throw unavailable('Cancel an existing native appearance preview before preparing more.');
        if (replacements.some(([, candidate]) => candidate.applying))
          throw unavailable('An appearance candidate is being applied to this model.');
        for (const [key, candidate] of replacements) { release(candidate); map.delete(key); }
        const stage = stageNativeAppearancePreview(c.model.id, prepared, i.settings, renderer);
        map.set(token, { modelId: c.model.id, revision: snapshot.revision, renderer, prepared, stage, owner }); adopted = true;
      });
      return { preview_token: token, model_id: c.model.id, revision: snapshot.revision, affected_products: [...new Set(prepared.plan.items.map(item => item.productId))], geometry_items: prepared.plan.items.length, created_entities: prepared.plan.created.length };
    } finally { planner.dispose(); if (!adopted) appearanceAssets.releaseOwner(owner); }
}
/** Internal native inspection seam; operation adapters must return bounded surface metadata. */
export function inspectAnalyticsAppearanceCandidate(host: ToolHost, id: string, modelId: string) {
  const candidate = owned(host).get(id);
  if (!candidate || candidate.modelId !== modelId) throw invalidInput('unknown-target', 'Unknown appearance candidate for this host/model.');
  if (candidate.applying) throw unavailable('The native appearance candidate is being applied.');
  if (appearanceRevision(modelId) !== candidate.revision || getGlobalRenderer() !== candidate.renderer) throw stale('Appearance model or renderer changed. Prepare a new candidate.');
  return { model_id: candidate.modelId, revision: candidate.revision, plan: candidate.prepared.plan, groups: candidate.stage.groups,
    original_shown: candidate.stage.session === null, applying: Boolean(candidate.applying) };
}

export const analyticsAppearanceOperations = [
  operation<{ source_id: string; express_ids: number[]; settings: Settings }>(metadata('appearance.preview', 'appearance', 'Prepare and stage an immutable native Rust texture mapping candidate on explicit model-qualified products, using registered image/PDF sources and the panel planner. Refuses partial exclusions; previews require native edit mode/role and a renderer.', ['read', 'view'], {
    type: 'object', properties: { preview_token: { type: 'string' }, model_id: { type: 'string' }, revision: { type: 'string' }, affected_products: { type: 'array', items: { type: 'integer' } }, geometry_items: { type: 'integer' }, created_entities: { type: 'integer' } }, required: ['preview_token', 'model_id', 'revision', 'affected_products', 'geometry_items', 'created_entities'], additionalProperties: false,
  }), {
    type: 'object', properties: { source_id: idSchema.properties.id, express_ids: { ...referenceSchema.properties.express_ids, minItems: 1, uniqueItems: true }, settings: settingsSchema }, required: ['source_id', 'express_ids', 'settings'], additionalProperties: false,
  } satisfies JSONSchemaType<{ source_id: string; express_ids: number[]; settings: Settings }>, prepareAnalyticsAppearanceCandidate),
  operation<{ id: string }>({ ...metadata('appearance.applyPreview', 'appearance', 'Apply exactly one immutable, revision-bound native appearance candidate as one native IFC/history transaction. Native edit mode/role, source validation and collaboration gates remain authoritative.', ['model', 'view'], {
    type: 'object', properties: { model_id: { type: 'string' }, committed: { type: 'boolean' }, affected_products: { type: 'array', items: { type: 'integer' } } }, required: ['model_id', 'committed', 'affected_products'], additionalProperties: false,
  }), policy: { model: 'native-reviewed' } }, idSchema, async (i, c) => {
    const map = owned(c.host); const candidate = map.get(i.id); if (!candidate || candidate.modelId !== c.model.id) throw invalidInput('unknown-target', 'Unknown appearance candidate for this host/model.');
    gate(c.model.id); if (appearanceRevision(c.model.id) !== candidate.revision || getGlobalRenderer() !== candidate.renderer) throw stale('Appearance model or renderer changed. Prepare a fresh preview.');
    if (candidate.applying) throw unavailable('The native appearance candidate is being applied.');
    const { session } = candidate.stage;
    if (!session) throw unavailable('Restore the native appearance preview before applying it.');
    checkpoint(c); candidate.applying = true;
    try {
      await c.commitAsync(() => commitAppearance(c.model.id, candidate.prepared.assetIds, candidate.prepared.plan, candidate.renderer, session, candidate.stage.groups, candidate.prepared.source));
      return { model_id: c.model.id, committed: true, affected_products: [...new Set(candidate.prepared.plan.items.map(item => item.productId))] };
    } finally { map.delete(i.id); release(candidate); }
  }),
  operation<{ id: string }>(metadata('appearance.cancelPreview', 'appearance', 'Discard a host-owned appearance preview and restore its native original render resources.', ['view'], { type: 'object', properties: { removed: { type: 'string' } }, required: ['removed'], additionalProperties: false }), idSchema, (i, c) => {
    const map = owned(c.host); const candidate = map.get(i.id); if (!candidate || candidate.modelId !== c.model.id) throw invalidInput('unknown-target', 'Unknown appearance preview for this host/model.');
    if (candidate.applying) throw unavailable('The native appearance candidate is being applied.');
    checkpoint(c); c.commit(() => { release(candidate); map.delete(i.id); }); return { removed: i.id };
  }),
];
