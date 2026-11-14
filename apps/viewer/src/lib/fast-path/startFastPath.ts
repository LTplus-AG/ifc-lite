/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Production wiring of the small-file fast path (fastPathRuntime.ts). Loaded
 * with a dynamic import at idle by bootstrap, so none of it is in the entry
 * chunk.
 */

import { compileSharedWasmModule, DEFAULT_GEOM_HASH_TOLERANCE } from '@ifc-lite/geometry';
import { hasSpareParserWorker, isSpareParserWorkerWarming, prepareSpareParser, releaseSpareParserWorker } from '@ifc-lite/parser/browser';
import { useViewerStore } from '@/store';
import { getGeomWorkerOverride, resolveLoadTessellationTier } from '@/store/constants';
import { USE_SERVER } from '@/utils/ifcConfig';
import { getPerfFlagDefinition, readPerfFlag } from '@/lib/perf/flags';
import { isFeatureEnabled, type FeatureId } from '@/lib/features';
import { mayWarmUp, scheduleWhenIdle } from '@/lib/warm-runtime-gate';
import { registerPickStarter } from '@/hooks/ingest/pickStart';
import { setFastGeometryClaimer } from '@/hooks/ingest/fastPath';
import { createFastPathRuntime, type FastPathRuntime } from './fastPathRuntime';

/** Shipped samples (never the user's file) that compile the engine's hot paths. */
const WARM_SAMPLES = ['samples/hello-wall.ifc', 'samples/building-architecture.ifc'];
const INPUT_EVENTS = ['pointerdown', 'keydown', 'dragenter'] as const;

async function fetchWarmSamples(): Promise<Uint8Array[]> {
  const base = import.meta.env.BASE_URL ?? '/';
  const out: Uint8Array[] = [];
  for (const path of WARM_SAMPLES) {
    try {
      const response = await fetch(`${base}${path}`);
      if (response.ok) out.push(new Uint8Array(await response.arrayBuffer()));
    } catch { /* a missing sample only means a colder first parse */ }
  }
  return out;
}

let runtime: FastPathRuntime | null = null;

/**
 * The switch: `?perf.fastPath=0` for a session, or the registry default
 * (`default: true` for `fastPath` in lib/perf/flags.ts) for everyone, a
 * one-line change. With it off nothing is prepared and every load meshes as before.
 */
export function fastPathSwitch(): unknown {
  return readPerfFlag('fastPath') ?? getPerfFlagDefinition('fastPath').default;
}

/** The features that each open a model in the browser (a federation setup has its own file picker). */
export const MODEL_SOURCES = ['files.local', 'files.samples', 'files.sources', 'files.federation-setup'] as const satisfies readonly FeatureId[];

/**
 * Whether this page can open a model at all. A host can switch off every
 * picker; then the warm-up's sample fetch and spare workers would serve no
 * load. `?model=` still autoloads with the pickers off, so it counts.
 */
export function pageCanOpenModels(): boolean {
  return MODEL_SOURCES.some((id) => isFeatureEnabled(id)) || Boolean(new URLSearchParams(window.location.search).get('model'));
}

/** Start the fast-path runtime once (idempotent). Returns whether it runs. */
export function startFastPath(): boolean {
  if (runtime) return true;
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return false;
  runtime = createFastPathRuntime({
    // A server-backed build meshes on the server; nothing to prepare here.
    allowed: () => !USE_SERVER && pageCanOpenModels() && mayWarmUp(fastPathSwitch()),
    // Measurement only: `?perf.fastPath=parser` or `=geometry` prepares one spare alone.
    parts: { parser: fastPathSwitch() !== 'geometry', geometry: fastPathSwitch() !== 'parser' },
    whenIdle: scheduleWhenIdle,
    isLoading: () => useViewerStore.getState().loading,
    subscribeLoading: (listener) => {
      let previous = useViewerStore.getState().loading;
      return useViewerStore.subscribe((state) => {
        if (state.loading === previous) return;
        previous = state.loading;
        listener(state.loading);
      });
    },
    isHidden: () => document.visibilityState !== 'visible',
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    onInput: (listener) => {
      for (const type of INPUT_EVENTS) window.addEventListener(type, listener, { capture: true, passive: true });
      return () => { for (const type of INPUT_EVENTS) window.removeEventListener(type, listener, { capture: true }); };
    },
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    compileModule: () => compileSharedWasmModule(),
    warmSamples: fetchWarmSamples,
    spawnGeometryWorker: () => new Worker(new URL('../../workers/fast-geometry.worker.ts', import.meta.url), { type: 'module' }),
    parser: { prepare: prepareSpareParser, has: hasSpareParserWorker, warming: isSpareParserWorkerWarming, release: releaseSpareParserWorker },
    settingsAtPick: (file) => {
      const { mergeLayers, geometryMode } = useViewerStore.getState();
      return {
        mergeLayers,
        enableInstancing: true,
        tessellationQuality: resolveLoadTessellationTier(file.size / (1024 * 1024), geometryMode) ?? null,
        skipSmallCuts: geometryMode === 'fast',
        skipVoids: false,
        geometryHashTolerance: DEFAULT_GEOM_HASH_TOLERANCE,
      };
    },
    workerCountOverride: getGeomWorkerOverride,
    registerPickStarter,
    setClaimer: setFastGeometryClaimer,
    log: (message) => console.log(message),
  });
  return runtime !== null;
}
