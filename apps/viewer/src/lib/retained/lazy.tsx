/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The retained kernel in a production build (`VITE_RETAINED_GEOMETRY=lazy`,
 * #7955). Same contract as `index.ts`, but nothing retained is in the eager
 * graph: this module holds only the kernel choice and dynamic imports.
 *
 * - The retained module (`./index`: client, load policy, chip, panel, strings)
 *   is a lazy chunk, fetched when a load asks for retained, when the Settings
 *   choice switches to retained, or at startup when the choice already is
 *   retained. The engine and SMLib under /retained-engine/ and /smlib/ are
 *   fetched later still, by the host Worker on the first retained run.
 * - The setting is its own small lazy chunk, fetched when Settings shows it.
 * - The chip renders nothing, and fetches nothing, until a model carries a
 *   retained summary, which only a retained load (and so the module) can set.
 *
 * `begin` must answer synchronously. When a load asks for retained before the
 * module has arrived, that attempt stops quietly (`refused` with no message)
 * and re-runs itself through `retry` once the module is in, which then decides
 * the kernel exactly as the `on` build does.
 */

import { lazy, Suspense } from 'react';
import { useViewerStore } from '@/store';
import { chooseGeometryKernel, requestedGeometryKernel, type GeometryKernel } from '@/store/geometryKernel';
import { hasRetainedGeometryModel } from '@/store/retainedGeometry';
import type { GeometryKernelLoad } from '@/hooks/ingest/geometryEventSource';
import type { RetainedKernel } from './kernel';

type LoadedKernel = RetainedKernel;
type Importer = () => Promise<{ retainedKernel: RetainedKernel | null }>;

let loaded: LoadedKernel | null = null;
let pending: Promise<LoadedKernel> | null = null;

/** Fetch the retained module once; a failed fetch is not cached, so a later load retries it. */
export function loadRetainedKernel(importer: Importer = () => import('./index')): Promise<LoadedKernel> {
  if (!pending) {
    const attempt = importer().then((module) => {
      if (!module.retainedKernel) throw new Error('The retained module has no kernel');
      loaded = module.retainedKernel;
      return loaded;
    });
    attempt.catch(() => { if (pending === attempt) pending = null; });
    pending = attempt;
  }
  return pending;
}

/** Test seam: forget the loaded module. */
export function resetRetainedKernelForTest(): void {
  loaded = null;
  pending = null;
}

// English only on purpose: the retained strings live in the lazy chunk that failed to arrive.
const LOAD_FAILED = 'The retained geometry kernel could not be downloaded. Retry loads this file with the exact kernel.';

/** The stand-in for one load while the module is fetched: retained policy, no work, no message. */
function deferredLoad(retry: () => void, importer?: Importer): GeometryKernelLoad {
  return {
    kind: 'retained',
    serverEnabled: false,
    cachePlan: (plan) => ({ ...plan, tier: 'none', shouldCache: false }),
    refuseSource: () => true,
    refused: loadRetainedKernel(importer).then(
      () => { retry(); },
      (error: unknown) => {
        console.warn('[retained] module fetch failed', error);
        const state = useViewerStore.getState();
        state.setError(LOAD_FAILED);
        state.setLastLoadRetry(() => { chooseGeometryKernel('exact'); retry(); });
      },
    ),
  };
}

/** `begin` for this build; exported with its importer as a test seam. */
export function beginLazy(
  file: File,
  target: { kind: 'primary' | 'federated' },
  retry: () => void,
  importer?: Importer,
): GeometryKernelLoad | null {
  if (loaded) return loaded.begin(file, target, retry);
  if (requestedGeometryKernel() !== 'retained') return null;
  return deferredLoad(retry, importer);
}

const LazyChip = lazy(() => loadRetainedKernel().then((kernel) => ({ default: kernel.Chip })));

function Chip({ reload }: { reload: (file: File) => unknown }) {
  const open = useViewerStore((state) => hasRetainedGeometryModel(state.models));
  if (!open) return null;
  return <Suspense fallback={null}><LazyChip reload={reload} /></Suspense>;
}

const LazySetting = lazy(() => import('@/components/viewer/settings/GeometryKernelSetting')
  .then((module) => ({ default: module.GeometryKernelSetting })));

function prefetch(kernel: GeometryKernel): void {
  if (kernel === 'retained') loadRetainedKernel().catch(() => { /* reported by the load that needs it */ });
}

function KernelSetting() {
  return <Suspense fallback={null}><LazySetting onChange={prefetch} /></Suspense>;
}

// A browser whose saved choice (or this tab's ?kernel=) is retained gets the
// module while the app starts, so its first load rarely needs the re-run.
if (typeof window !== 'undefined') prefetch(requestedGeometryKernel());

export const retainedKernel: RetainedKernel | null = {
  requested: requestedGeometryKernel,
  begin: (file, target, retry) => beginLazy(file, target, retry),
  Chip,
  KernelSetting,
};
