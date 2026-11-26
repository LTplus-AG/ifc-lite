/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shows one surface of a processor. `A2uiSurface` renders nothing until the
 * surface has its root component, so while a reply is still streaming we show
 * our own placeholder instead of an empty gap.
 */

import { Component, useEffect, useState, type ReactNode } from 'react';
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react';
import type { MessageProcessor, SurfaceModel } from '@a2ui/web_core/v1_0';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { Note } from './notes';

type Surface = SurfaceModel<ReactCatalogComponent>;

function useSurface(processor: MessageProcessor<ReactCatalogComponent>, surfaceId: string): Surface | undefined {
  const [surface, setSurface] = useState(() => processor.getSurface(surfaceId));
  useEffect(() => {
    setSurface(processor.getSurface(surfaceId));
    const created = processor.onSurfaceCreated((s) => { if (s.id === surfaceId) setSurface(s); });
    const deleted = processor.onSurfaceDeleted((id) => { if (id === surfaceId) setSurface(undefined); });
    return () => { created.unsubscribe(); deleted.unsubscribe(); };
  }, [processor, surfaceId]);
  return surface;
}

function useHasRoot(surface: Surface | undefined): boolean {
  const [hasRoot, setHasRoot] = useState(() => !!surface?.componentsModel.has(surface.rootId));
  useEffect(() => {
    if (!surface) { setHasRoot(false); return; }
    setHasRoot(surface.componentsModel.has(surface.rootId));
    const sub = surface.componentsModel.onCreated.subscribe((c) => { if (c.id === surface.rootId) setHasRoot(true); });
    return () => sub.unsubscribe();
  }, [surface]);
  return hasRoot;
}

/** A broken surface must not take the chat down with it. */
class SurfaceBoundary extends Component<{ fallback: (error: Error) => ReactNode; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[a2ui] surface render failed', error); }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

export function SurfaceView({ processor, surfaceId }: { processor: MessageProcessor<ReactCatalogComponent>; surfaceId: string }) {
  const { t } = useTranslation();
  const surface = useSurface(processor, surfaceId);
  const hasRoot = useHasRoot(surface);
  return (
    <section aria-label={t('a2ui.surfaceLabel')} data-a2ui-surface={surfaceId} className="my-2 min-w-0 text-sm">
      {!hasRoot && (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          {t('a2ui.loading')}
        </div>
      )}
      {surface && (
        <SurfaceBoundary fallback={(error) => <Note tone="error">{t('a2ui.action.failed', { reason: error.message })}</Note>}>
          <A2uiSurface surface={surface} />
        </SurfaceBoundary>
      )}
    </section>
  );
}
