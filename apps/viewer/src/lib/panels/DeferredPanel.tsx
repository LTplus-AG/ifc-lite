/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Suspense, useEffect, useMemo, useReducer, type ComponentType, type ReactNode } from 'react';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary';
import { PanelHeader } from '@/components/ui/panel-header';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { panelTitleKey } from './registry';

type DeferredPanelId = 'bcf' | 'validation' | 'lens' | 'gantt' | 'lists' | 'extensions';
const labels = { bcf: 'BCF panel', validation: 'Validation panel', lens: 'Lens panel', gantt: 'Gantt panel', lists: 'Lists panel', extensions: 'Extensions panel' } as const;

type PanelModule = { default: ComponentType<{ onClose?: () => void }> };
export type DeferredPanelLoader = () => Promise<PanelModule>;
type PanelOutcome = { state: 'pending' } | { state: 'ready'; module: PanelModule } | { state: 'failed'; error: unknown };
type PanelResource = { outcome: PanelOutcome; settled: Promise<void> };
const resources = new WeakMap<DeferredPanelLoader, PanelResource>();

function resourceFor(load: DeferredPanelLoader): PanelResource {
  const known = resources.get(load);
  if (known) return known;
  const pending = load();
  const resource: PanelResource = { outcome: { state: 'pending' }, settled: Promise.resolve() };
  resources.set(load, resource);
  // Settle without rejecting: the mounted body throws the recorded error into
  // ChunkErrorBoundary, including when the import failed while it was closed.
  resource.settled = pending.then(
    module => { resource.outcome = { state: 'ready', module }; },
    error => { resource.outcome = { state: 'failed', error }; },
  );
  return resource;
}

function LoadedBody({ load, onClose, fallback }: { load: DeferredPanelLoader; onClose: () => void; fallback: ReactNode }) {
  const resource = useMemo(() => resourceFor(load), [load]);
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    let mounted = true;
    void resource.settled.then(() => { if (mounted) refresh(); });
    return () => { mounted = false; };
  }, [resource]);
  if (resource.outcome.state === 'failed') throw resource.outcome.error;
  if (resource.outcome.state === 'pending') return fallback;
  const Panel = resource.outcome.module.default;
  return <Panel onClose={onClose} />;
}

/** Keep a cold panel visible and dismissible while its module arrives. */
export function DeferredPanel({ id, onClose, children, load }: {
  id: DeferredPanelId; onClose: () => void;
} & ({ load: DeferredPanelLoader; children?: never } | { children: ReactNode; load?: never })) {
  const { t } = useTranslation();
  const shell = (content: ReactNode) => <div className="flex h-full flex-col">
    <PanelHeader title={t(panelTitleKey(id))} onClose={onClose} />
    <div className="min-h-0 flex-1 p-4">{content}</div>
  </div>;
  const loading = shell(<output className="flex items-center gap-2 text-sm text-muted-foreground">
    <Spinner className="h-4 w-4" />{t('shellChrome.statusBar.loadingFallback')}
  </output>);
  return <ChunkErrorBoundary key={id} label={labels[id]} renderFallback={shell}>
    {/* #9742: ordinary state updates avoid React's 300 ms Suspense retry
        throttle, which otherwise misses the gap before welcome WebGL work. */}
    {load ? <LoadedBody load={load} onClose={onClose} fallback={loading} />
      : <Suspense fallback={loading}>{children}</Suspense>}
  </ChunkErrorBoundary>;
}
