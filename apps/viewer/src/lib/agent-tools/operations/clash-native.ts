/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import type { Clash } from '@ifc-lite/clash';
import { viewerOperation, emptySchema, type ViewerOperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ToolHost } from '../types';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, effect: 'read' | 'configuration' | 'view' | 'artifact' = 'read') => ({
  id,
  owner: 'clash',
  description,
  effects: [effect],
  capability: effect === 'read' ? ('read' as const) : ('commands-and-edits' as const),
  implementation: 'native-store' as const,
  outputSchema,
  policy: effect === 'artifact' ? { artifact: 'native-export' as const } : undefined,
});
const hosts = new WeakMap<
  ToolHost,
  { runEpochRef: { current: number }; runAbortRef: { current: AbortController | null } }
>();
export async function clashRuntime(
  c: ViewerOperationContext,
  emit?: (blob: Blob, filename: string) => void | Promise<void>,
) {
  const { createNativeClashRuntime } = await import('@/lib/clash/clash-native-runtime');
  assertToolActive(c);
  let refs = hosts.get(c.host);
  if (!refs) {
    refs = { runEpochRef: { current: 0 }, runAbortRef: { current: null } };
    hosts.set(c.host, refs);
    const owned = refs;
    c.host.lifetimeSignal?.addEventListener(
      'abort',
      () => {
        owned.runAbortRef.current?.abort();
        owned.runEpochRef.current++;
      },
      { once: true },
    );
  }
  return createNativeClashRuntime(refs, { signal: c.signal, emit, publish: (write) => c.commit(write) });
}
export function currentClash(run_seq: number, id: string): Clash {
  const s = useViewerStore.getState();
  if (s.clashRunSeq !== run_seq) throw new Error('Clash results changed. Inspect again.');
  const clash = s.clashResult?.clashes.find((row) => row.id === id);
  if (!clash) throw new Error('Unknown clash in the current native result.');
  return clash;
}
export function clashSettings() {
  const s = useViewerStore.getState();
  return {
    mode: s.clashMode,
    tolerance: s.clashTolerance,
    clearance: s.clashClearance,
    duplicateTolerance: s.clashDuplicateTolerance,
    clusterEpsilon: s.clashClusterEpsilon,
    reportTouch: s.clashReportTouch,
    groupBy: s.clashGroupBy,
    sortBy: s.clashSortBy,
    hideTouching: s.clashHideTouching,
    focusMode: s.clashFocusMode,
    showRegionBox: s.showClashRegionBox,
  };
}
export const nativeClashOperations = [
  viewerOperation(
    meta(
      'clash.state',
      'Read native clash settings/presets/exclusions/reviews, exact stale-state signatures, run progress and focus-solid status. Does not gather geometry.',
    ),
    emptySchema,
    () => {
      const s = useViewerStore.getState();
      return out({
        settings: clashSettings(),
        expected_settings: JSON.stringify(clashSettings()),
        presets: s.clashPresets,
        expected_presets: JSON.stringify(s.clashPresets),
        exclusions: s.clashExclusions,
        expected_exclusions: JSON.stringify(s.clashExclusions),
        reviews: [...s.clashReviews],
        statusFilter: [...s.clashStatusFilter],
        run_seq: s.clashRunSeq,
        running: s.clashRunning,
        progress: s.clashProgress,
        error: s.clashError,
        result: s.clashResult
          ? {
              summary: s.clashResult.summary,
              count: s.clashResult.clashes.length,
              rules: s.clashResult.rulesRun,
              coverage: s.clashResult.ruleCoverage,
            }
          : null,
        solid: { status: s.clashSolidStatus, volumeM3: s.clashSolidVolumeM3, reason: s.clashSolidReason },
        suppressed: s.clashSuppressedCount,
        exclusionCounts: [...s.clashExclusionCounts],
      });
    },
  ),
  viewerOperation<{ offset: number; limit: number; run_seq: number }>(
    meta('clash.results', 'Read a bounded page of complete native clash pairs and durable review annotations.'),
    {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        run_seq: { type: 'integer', minimum: 0 },
      },
      required: ['offset', 'limit', 'run_seq'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { clashReviewKey } = await import('@ifc-lite/clash');
      assertToolActive(c);
      const s = useViewerStore.getState();
      if (s.clashRunSeq !== i.run_seq) throw new Error('Clash results changed.');
      return out({
        total: s.clashResult?.clashes.length ?? 0,
        clashes:
          s.clashResult?.clashes
            .slice(i.offset, i.offset + i.limit)
            .map((clash) => ({ clash, review: s.clashReviews.get(clashReviewKey(clash)) ?? { status: 'open' } })) ?? [],
      });
    },
  ),
  viewerOperation<{
    kind: 'all' | 'matrix' | 'preset' | 'duplicates' | 'rerun';
    preset_id: string;
    expected_model_ids: string[];
    expected_settings: string;
  }>(
    meta(
      'clash.run',
      'Run the actual native federated Clash workflow and publish its native panel result: all, matrix, preset, duplicates or exact recorded rerun. Native model/tag/filter/exclusion/placement/run-epoch guards remain active. Completes after detection; cancellation aborts the native engine.',
      'configuration',
    ),
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['all', 'matrix', 'preset', 'duplicates', 'rerun'] },
        preset_id: { type: 'string', maxLength: 200 },
        expected_model_ids: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
        expected_settings: { type: 'string', maxLength: 10000 },
      },
      required: ['kind', 'preset_id', 'expected_model_ids', 'expected_settings'],
      additionalProperties: false,
    },
    async (i, c) => {
      const [{ rerunClashRequest, runRequestOf }, runtime] = await Promise.all([
        import('@/lib/clash/run-request'),
        clashRuntime(c),
      ]);
      const s = useViewerStore.getState();
      if (
        JSON.stringify([...s.models.keys()].sort()) !== JSON.stringify([...i.expected_model_ids].sort()) ||
        JSON.stringify(clashSettings()) !== i.expected_settings
      )
        throw new Error('Clash inputs changed. Inspect again.');
      const seq = s.clashRunSeq;
      const cancel = () => runtime.cancelRun();
      c.signal?.addEventListener('abort', cancel, { once: true });
      try {
        assertToolActive(c);
        if (i.kind === 'rerun') await rerunClashRequest(runRequestOf(s.clashRawResult), runtime);
        else if (i.kind === 'all') await runtime.runAll();
        else if (i.kind === 'matrix') await runtime.runMatrix();
        else if (i.kind === 'preset') await runtime.runPreset(i.preset_id);
        else await runtime.runDuplicates();
        assertToolActive(c);
        const end = useViewerStore.getState();
        if (end.clashRunSeq === seq)
          throw new Error(end.clashError ?? 'Native run was cancelled, superseded or refused.');
        return out({
          run_seq: end.clashRunSeq,
          count: end.clashResult?.clashes.length ?? 0,
          summary: end.clashResult?.summary,
        });
      } finally {
        c.signal?.removeEventListener('abort', cancel);
      }
    },
  ),
  viewerOperation<{
    action: 'cancel' | 'clear' | 'highlightAll' | 'clearHighlight' | 'invalidateSolid' | 'resetSettings';
  }>(
    meta(
      'clash.action',
      'Use native clash cancellation/clear/highlight/solid invalidation handlers. Clear retains durable review/exclusion settings, matching the panel.',
      'view',
    ),
    {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['cancel', 'clear', 'highlightAll', 'clearHighlight', 'invalidateSolid', 'resetSettings'],
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async (i, c) => {
      const runtime = await clashRuntime(c);
      return out(
        c.commit(() => {
          if (i.action === 'cancel') runtime.cancelRun();
          else if (i.action === 'clear') runtime.clearAll();
          else if (i.action === 'highlightAll') runtime.highlightAll();
          else if (i.action === 'clearHighlight') runtime.clearHighlight();
          else if (i.action === 'resetSettings') useViewerStore.getState().resetClashSettings();
          else runtime.invalidateSolidCompute();
          return { completed: i.action };
        }),
      );
    },
  ),
  viewerOperation<{
    clash_ids: string[];
    run_seq: number;
    mode: 'highlight' | 'isolate' | 'ghost';
    element: 'pair' | 'a' | 'b';
  }>(
    {
      ...meta(
        'clash.focus',
        'Focus an exact native pair, one side or a group with native federation/ref/visibility ownership and latest-solid guards. Pair solid computation is dispatched; inspect clash.state for its actual outcome.',
        'view',
      ),
      completion: 'dispatched',
    },
    {
      type: 'object',
      properties: {
        clash_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        run_seq: { type: 'integer', minimum: 0 },
        mode: { type: 'string', enum: ['highlight', 'isolate', 'ghost'] },
        element: { type: 'string', enum: ['pair', 'a', 'b'] },
      },
      required: ['clash_ids', 'run_seq', 'mode', 'element'],
      additionalProperties: false,
    },
    async (i, c) => {
      const runtime = await clashRuntime(c);
      const pairs = i.clash_ids.map((id) => currentClash(i.run_seq, id));
      if (i.element !== 'pair' && pairs.length !== 1) throw new Error('Choose one clash for a single-element focus.');
      return out(
        c.commit(() => {
          if (i.element !== 'pair') runtime.selectElement(pairs[0][i.element], i.mode);
          else if (pairs.length === 1) {
            runtime.focusClash(pairs[0], i.mode);
            if (useViewerStore.getState().clashSelectedId !== pairs[0].id)
              throw new Error(useViewerStore.getState().clashError ?? 'Native pair focus refused.');
          } else if (!runtime.focusClashes(pairs, i.mode))
            throw new Error(useViewerStore.getState().clashError ?? 'Native group focus refused.');
          return {
            dispatched: true,
            solidStatus: useViewerStore.getState().clashSolidStatus,
            error: useViewerStore.getState().clashError,
          };
        }),
      );
    },
  ),
];
