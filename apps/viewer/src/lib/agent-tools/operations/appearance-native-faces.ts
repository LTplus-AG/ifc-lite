/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { operation, type OperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import { decodeAppearanceSettings } from './appearance-native-common';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, write = false) => ({
  id,
  owner: 'appearance',
  description,
  effects: write ? (['view'] as const) : (['read'] as const),
  capability: write ? ('commands-and-edits' as const) : ('read' as const),
  implementation: 'native-store' as const,
  outputSchema,
});
async function candidate(c: OperationContext, id: string) {
  const { inspectAnalyticsAppearanceCandidate } = await import('./analytics-appearance');
  assertToolActive(c);
  return inspectAnalyticsAppearanceCandidate(c.host, id, c.model.id);
}
export const appearanceFaceOperations = [
  operation<{ source_id: string; express_ids: number[]; settings_json: string }>(
    meta(
      'appearance.plan',
      'Read the exact native Rust appearance plan support/exclusion/conversion report before staging. Supports the UI supported-only narrowing workflow: use the returned explicit supported_product_ids for a fresh preview, without committing or silently dropping exclusions.',
    ),
    {
      type: 'object',
      properties: {
        source_id: { type: 'string', minLength: 1, maxLength: 200 },
        express_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          uniqueItems: true,
          items: { type: 'integer', minimum: 1 },
        },
        settings_json: { type: 'string', maxLength: 20000 },
      },
      required: ['source_id', 'express_ids', 'settings_json'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [
        { prepareAppearanceSnapshot },
        { prepareNativeAppearancePlan },
        { createAppearancePlanner },
        { appearanceAssets },
        { useViewerStore },
        { resolveRef },
        settings,
      ] = await Promise.all([
        import('@/lib/appearance/snapshot'),
        import('@/lib/appearance/prepare-native-preview'),
        import('@/lib/appearance/planner-worker-client'),
        import('@/lib/appearance/model-assets'),
        import('@/store'),
        import('../refs'),
        decodeAppearanceSettings(i.settings_json),
      ]);
      for (const express_id of i.express_ids) resolveRef(c.model, { express_id });
      if (!c.signal) throw new Error('A live cancellation signal is required.');
      assertToolActive(c);
      const source = useViewerStore.getState().appearanceSources.find((item) => item.id === i.source_id),
        owner = { kind: 'draft' as const, id: crypto.randomUUID() },
        planner = createAppearancePlanner();
      try {
        const snapshot = await prepareAppearanceSnapshot(null, c.model.id, i.express_ids, planner, c.signal),
          prepared = await prepareNativeAppearancePlan({
            snapshot,
            productIds: i.express_ids,
            sourceId: i.source_id,
            selectedSource: source,
            settings,
            planner,
            owner,
            signal: c.signal,
          });
        assertToolActive(c);
        snapshot.validate();
        if (source && useViewerStore.getState().appearanceSources.find((item) => item.id === i.source_id) !== source)
          throw new Error('The selected appearance source changed during planning.');
        return out({
          supported_product_ids: [...new Set(prepared.plan.items.map((item) => item.productId))],
          exclusions: prepared.plan.exclusions,
          conversions: (prepared.plan.conversions ?? []).map((item) => ({
            product_id: item.productId,
            surface_fingerprint: item.surfaceFingerprint,
            triangles: item.sourceIndices.length / 3,
          })),
          created_entities: prepared.plan.created.length,
        });
      } finally {
        planner.dispose();
        appearanceAssets.releaseOwner(owner);
      }
    },
  ),
  operation<{ candidate_id: string }>(
    meta(
      'appearance.faces.inspect',
      'Inspect exact native candidate converted products, source-surface fingerprints and triangle ordinals before authoring face masks. Source/renderer/revision/applying guards remain authoritative.',
    ),
    {
      type: 'object',
      properties: { candidate_id: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['candidate_id'],
      additionalProperties: false,
    },
    async (i, c) => {
      const current = await candidate(c, i.candidate_id);
      return out({
        model_id: current.model_id,
        revision: current.revision,
        surfaces: (current.plan.conversions ?? []).map((item) => ({
          product_id: item.productId,
          surface_fingerprint: item.surfaceFingerprint,
          triangles: item.sourceIndices.length / 3,
          available: item.sourcePositions !== undefined,
        })),
        diagnostics: current.plan.exclusions,
        original_shown: current.original_shown,
        applying: current.applying,
      });
    },
  ),
  operation<{ candidate_id: string; original: boolean }>(
    meta(
      'appearance.compare',
      'Show original or staged appearance using the shared native Compare handler while preserving the same immutable plan/assets/face masks. Does not cancel/discard the candidate; applying or stale candidates are refused.',
      true,
    ),
    {
      type: 'object',
      properties: { candidate_id: { type: 'string', minLength: 1, maxLength: 100 }, original: { type: 'boolean' } },
      required: ['candidate_id', 'original'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { compareAnalyticsAppearancePreview } = await import('./analytics-appearance');
      assertToolActive(c);
      return out(c.commit(() => compareAnalyticsAppearancePreview(c.host, i.candidate_id, c.model.id, i.original)));
    },
  ),
  operation<{
    candidate_id: string;
    source_id: string;
    express_ids: number[];
    settings_json: string;
    masks: Array<{ product_id: number; surface_fingerprint: string; triangles: number[] }>;
  }>(
    meta(
      'appearance.faces.prepare',
      'Create a new immutable native preview with explicit reviewed triangle masks on the prior candidate’s evaluated occurrence surfaces. Uses the exact shared UI mask reducer, native faceMaskRequests/reconcileFaceMasks and canonical preview planner. Full/empty surface selections retain native unmasked semantics; stale fingerprints/ordinals refuse.',
      true,
    ),
    {
      type: 'object',
      properties: {
        candidate_id: { type: 'string', minLength: 1, maxLength: 100 },
        source_id: { type: 'string', minLength: 1, maxLength: 200 },
        express_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          uniqueItems: true,
          items: { type: 'integer', minimum: 1 },
        },
        settings_json: { type: 'string', maxLength: 20000 },
        masks: {
          type: 'array',
          maxItems: 1000,
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'integer', minimum: 1 },
              surface_fingerprint: { type: 'string', minLength: 1, maxLength: 4096 },
              triangles: {
                type: 'array',
                maxItems: 200000,
                uniqueItems: true,
                items: { type: 'integer', minimum: 0, maximum: 10000000 },
              },
            },
            required: ['product_id', 'surface_fingerprint', 'triangles'],
            additionalProperties: false,
          },
        },
      },
      required: ['candidate_id', 'source_id', 'express_ids', 'settings_json', 'masks'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [
        old,
        { changeNativeFaceMask, faceMaskRequests, reconcileFaceMasks },
        { prepareAnalyticsAppearanceCandidate },
      ] = await Promise.all([
        candidate(c, i.candidate_id),
        import('@/lib/appearance/face-masks'),
        import('./analytics-appearance'),
      ]);
      const settings = await decodeAppearanceSettings(i.settings_json);
      if (settings.representationPolicy !== 'evaluatedOccurrence')
        throw new Error('Face masks require native evaluatedOccurrence policy.');
      if (i.masks.reduce((count, mask) => count + mask.triangles.length, 0) > 200000)
        throw new Error('Face selection request exceeds the native operation triangle budget.');
      let masks: import('@/lib/appearance/face-masks').FaceMasks = new Map();
      const ids = new Set<number>();
      for (const mask of i.masks) {
        if (ids.has(mask.product_id) || !i.express_ids.includes(mask.product_id))
          throw new Error('Mask products must be unique and explicitly in scope.');
        ids.add(mask.product_id);
        const conversion = old.plan.conversions?.find((item) => item.productId === mask.product_id);
        if (
          !conversion ||
          conversion.surfaceFingerprint !== mask.surface_fingerprint ||
          mask.triangles.some((ordinal) => ordinal >= conversion.sourceIndices.length / 3)
        )
          throw new Error('The native face surface or ordinal changed.');
        masks = changeNativeFaceMask(masks, old.plan.conversions, mask.product_id, mask.triangles);
      }
      assertToolActive(c);
      await candidate(c, i.candidate_id);
      const prepared = await prepareAnalyticsAppearanceCandidate(
        { source_id: i.source_id, express_ids: i.express_ids, settings },
        c,
        faceMaskRequests(masks, i.express_ids),
      );
      const next = await candidate(c, prepared.preview_token);
      const reconciled = reconcileFaceMasks(masks, next.plan, (id) => `IFC object #${id}`);
      return out({
        candidate: prepared,
        diagnostics: reconciled.diagnostics,
        masks: [...reconciled.masks.values()].map((mask) => ({ ...mask, triangles: [...mask.triangles] })),
      });
    },
  ),
];
