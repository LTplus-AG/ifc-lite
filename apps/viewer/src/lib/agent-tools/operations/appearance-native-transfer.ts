/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { operation } from './contract';
import { assertToolActive } from '../cancellation';
import { resolveRef } from '../refs';
import { nativeScanState, releaseNativeScanTransfer } from './appearance-native-scan-context';
import type { ScanTransferSettings } from '@/lib/appearance/scan/prepare-transfer';
const settingsSchema: JSONSchemaType<ScanTransferSettings> = {
  type: 'object',
  properties: {
    toleranceMetres: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 },
    reviewed: { type: 'boolean' },
    texelsPerMetre: { type: 'number', exclusiveMinimum: 0, maximum: 1e6 },
    maxDistanceMetres: { type: 'number', minimum: 0, maximum: 1e6 },
    minNormalDot: { type: 'number', minimum: -1, maximum: 1 },
    ambiguityDistanceMetres: { type: 'number', minimum: 0, maximum: 1e6 },
    maxBehindMetres: { type: 'number', minimum: 0, maximum: 1e6 },
    neighborhoodRadiusMetres: { type: 'number', exclusiveMinimum: 0, maximum: 0.5 },
    minNeighbors: { type: 'integer', minimum: 3, maximum: 1000000 },
    maxNeighbors: { type: 'integer', minimum: 3, maximum: 1000000 },
    surfaceBandMetres: { type: 'number', exclusiveMinimum: 0, maximum: 0.5 },
  },
  required: [
    'toleranceMetres',
    'reviewed',
    'texelsPerMetre',
    'maxDistanceMetres',
    'minNormalDot',
    'ambiguityDistanceMetres',
    'maxBehindMetres',
    'neighborhoodRadiusMetres',
    'minNeighbors',
    'maxNeighbors',
    'surfaceBandMetres',
  ],
  additionalProperties: false,
};
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, model = false) => ({
  id,
  owner: 'appearance',
  description,
  effects: model ? (['model', 'view'] as const) : (['view'] as const),
  capability: 'commands-and-edits' as const,
  implementation: 'native-store' as const,
  outputSchema,
  policy: model ? { model: 'native-reviewed' as const } : undefined,
});
const tokenInput = {
  type: 'object' as const,
  properties: {
    token: { type: 'string' as const, minLength: 1, maxLength: 100 },
    version: { type: 'integer' as const, minimum: 0 },
  },
  required: ['token' as const, 'version' as const],
  additionalProperties: false as const,
};
export const appearanceTransferOperations = [
  operation<{ token: string; version: number; express_ids: number[]; settings: ScanTransferSettings }>(
    meta(
      'appearance.scan.transfer.prepare',
      'Prepare/stage the actual native mesh or RGB-point appearance transfer on explicit IFC products. Uses prepareMeshTransfer’s fit/check/project-tolerance/review/coverage/point-support gates, image leases and exact shared native preview binding. Native inapplicable/excluded outcomes stay explicit; no fabricated texture coverage.',
    ),
    {
      type: 'object',
      properties: {
        ...tokenInput.properties,
        express_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          uniqueItems: true,
          items: { type: 'integer', minimum: 1 },
        },
        settings: settingsSchema,
      },
      required: ['token', 'version', 'express_ids', 'settings'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ prepareMeshTransfer }, { createAppearancePlanner }, { appearanceAssets }, { stageNativeScanTransfer }] =
        await Promise.all([
          import('@/lib/appearance/scan/prepare-transfer'),
          import('@/lib/appearance/planner-worker-client'),
          import('@/lib/appearance/model-assets'),
          import('@/lib/appearance/appearance-native-transfer'),
        ]);
      const state = nativeScanState(c, i.token, i.version);
      if (!state.result || !c.signal) throw new Error('Calculate and review a current native scan registration first.');
      for (const express_id of i.express_ids) resolveRef(c.model, { express_id });
      const renderer = getGlobalRenderer();
      if (!renderer) throw new Error('The native viewport is unavailable.');
      releaseNativeScanTransfer(state);
      const planner = createAppearancePlanner(),
        owner = { kind: 'draft' as const, id: crypto.randomUUID() };
      let adopted = false;
      try {
        const output = await prepareMeshTransfer(
          state.session,
          state.result,
          i.express_ids,
          i.settings,
          planner,
          owner,
          c.signal,
        );
        assertToolActive(c);
        nativeScanState(c, i.token, i.version);
        if (getGlobalRenderer() !== renderer) throw new Error('The native renderer changed during transfer.');
        if (!output.plan || !output.transfer.applicable || !(output.transfer.coverage.observedRasterInteriorTexels > 0))
          return out({ ready: false, coverage: output.transfer });
        if (output.transfer.exclusions.length)
          throw new Error(`Native transfer excludes target objects: ${JSON.stringify(output.transfer.exclusions)}`);
        const stage = c.commit(() => stageNativeScanTransfer(output, c.model.id, renderer));
        state.transfer = { output, owner, stage, renderer };
        state.version++;
        adopted = true;
        return out({ ready: true, version: state.version, coverage: output.transfer });
      } finally {
        planner.dispose();
        if (!adopted) appearanceAssets.releaseOwner(owner);
      }
    },
  ),
  operation<{ token: string; version: number; original: boolean }>(
    meta(
      'appearance.scan.transfer.compare',
      'Compare the exact native scan-transfer candidate with original appearance while retaining its immutable plan/images/coverage and calibration. Uses the same shared native Compare reducer as both Appearance panels.',
    ),
    {
      type: 'object',
      properties: { ...tokenInput.properties, original: { type: 'boolean' } },
      required: ['token', 'version', 'original'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { compareNativeAppearancePreview } = await import('@/lib/appearance/appearance-native-preview');
      assertToolActive(c);
      const state = nativeScanState(c, i.token, i.version),
        transfer = state.transfer,
        renderer = getGlobalRenderer();
      if (!transfer || !renderer || renderer !== transfer.renderer)
        throw new Error('No current native transfer preview or renderer changed.');
      return out(
        c.commit(() => {
          transfer.stage.preview = compareNativeAppearancePreview(
            renderer,
            transfer.stage.groups,
            transfer.stage.preview,
            i.original,
          );
          return { original: i.original, version: state.version };
        }),
      );
    },
  ),
  operation<{ token: string; version: number }>(
    meta(
      'appearance.scan.transfer.apply',
      'Apply the exact reviewed native scan transfer using commitAppearance’s native IFC/GPU/history transaction and role/source guards. Rebind/recompute registration using native unchanged-surface proof afterward; a completed edit with failed/cancelled revalidation explicitly reports recovery required.',
      true,
    ),
    tokenInput,
    async (i, c) => {
      const [
        { commitAppearance },
        { compareNativeAppearancePreview },
        { refreshNativeScanBinding },
        { createAppearancePlanner },
      ] = await Promise.all([
        import('@/lib/appearance/command'),
        import('@/lib/appearance/appearance-native-preview'),
        import('@/lib/appearance/appearance-native-scan'),
        import('@/lib/appearance/planner-worker-client'),
      ]);
      const state = nativeScanState(c, i.token, i.version),
        transfer = state.transfer,
        registration = state.result,
        renderer = getGlobalRenderer();
      if (!transfer?.output.plan || !registration || !renderer || renderer !== transfer.renderer || !c.signal)
        throw new Error('No current reviewed native transfer.');
      if (transfer.applied) return out(transfer.applied);
      const recovery = { request: registration.request, rebind: state.session.afterAppearance() };
      if (!transfer.stage.preview) {
        const preview = c.commit(() => compareNativeAppearancePreview(renderer, transfer.stage.groups, null, false));
        if (!preview) throw new Error('Native preview could not be restored.');
        transfer.stage.preview = preview;
      }
      const { preview } = transfer.stage;
      transfer.applying = true;
      try {
        await c.commitAsync(() =>
          commitAppearance(
            c.model.id,
            transfer.output.assetIds,
            transfer.output.plan!,
            renderer,
            preview,
            transfer.stage.groups,
            state.session.appearanceSource,
            { signal: c.signal, onProgress: () => c.checkpoint?.() },
          ),
        );
        transfer.applied = { committed: true, revalidation_required: true };
        state.recovery = recovery;
        state.result = undefined;
        state.version++;
        const planner = createAppearancePlanner();
        try {
          const refreshed = await refreshNativeScanBinding(state.session, recovery, planner, c.signal);
          state.session = refreshed.session;
          state.result = refreshed.result;
          state.recovery = refreshed.recovery;
          releaseNativeScanTransfer(state);
          return out({
            committed: true,
            revalidation_required: false,
            version: state.version,
            registration: state.result,
          });
        } catch (error) {
          releaseNativeScanTransfer(state);
          return out({
            committed: true,
            revalidation_required: true,
            version: state.version,
            reason: error instanceof Error ? error.message : String(error),
          });
        } finally {
          planner.dispose();
        }
      } finally {
        transfer.applying = false;
        if (transfer.releaseRequested) releaseNativeScanTransfer(state);
      }
    },
  ),
  operation<{ token: string; version: number }>(
    meta(
      'appearance.scan.revalidate',
      'Run the native retained-surface proof and registration refresh after a completed/cancelled appearance transaction. Refuses changed sources/frames/paired IFC geometry and preserves recovery state for a later explicit retry.',
    ),
    tokenInput,
    async (i, c) => {
      const [{ refreshNativeScanBinding }, { createAppearancePlanner }] = await Promise.all([
        import('@/lib/appearance/appearance-native-scan'),
        import('@/lib/appearance/planner-worker-client'),
      ]);
      const state = nativeScanState(c, i.token, i.version, false);
      if (state.transfer?.applying) throw new Error('The native transfer is being applied.');
      if (!state.recovery || !c.signal) throw new Error('No native retained binding is available for recovery.');
      const planner = createAppearancePlanner();
      try {
        const refreshed = await refreshNativeScanBinding(state.session, state.recovery, planner, c.signal);
        assertToolActive(c);
        state.session = refreshed.session;
        state.result = refreshed.result;
        state.recovery = refreshed.recovery;
        state.version++;
        return out({ version: state.version, result: state.result });
      } finally {
        planner.dispose();
      }
    },
  ),
  operation<{ token: string; version: number }>(
    meta(
      'appearance.scan.transfer.discard',
      'Discard the host-owned native scan-transfer preview and its image/renderer leases; retain registration/landmark evidence for explicit further work.',
    ),
    tokenInput,
    (i, c) => {
      const state = nativeScanState(c, i.token, i.version, false);
      if (state.transfer?.applying) throw new Error('The native transfer is being applied.');
      return out(
        c.commit(() => {
          releaseNativeScanTransfer(state);
          state.version++;
          return { discarded: true, version: state.version };
        }),
      );
    },
  ),
];
