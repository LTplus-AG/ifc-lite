/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model-dependent workspace panel opened on an empty viewer.
 *
 * Field replays: sessions that never load a model still open panels, Lens,
 * Charts, Zones, Presentation, Environment, Model and more, and get the
 * panel's controls over nothing (or one grey line). Only the viewport's
 * welcome card offered a way in, and an open bottom panel pushes that card
 * half out of view. So the panel itself now says it needs a model and
 * offers the same two ways in as the welcome card, under the same labels:
 * the tour demo project (through the canonical `loadFile`, via the
 * `ifc-lite:load-file` bus) and the file picker (`ifc-lite:open-files`,
 * dispatched inside the click so Chromium's picker keeps user activation).
 *
 * `takeover` replaces a panel whose whole content is model-derived;
 * `banner` sits above a panel that also has model-independent work (a list
 * or document can be authored before a model exists). Which panel gets
 * which is `panelModelGateMode` in `lib/panels/registry.ts`.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Building2, FolderOpen, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { trackUiEvent } from '@/lib/analytics';
import { getPanelDef, panelTitleKey, type PanelModelGateMode, type WorkspacePanelId } from '@/lib/panels/registry';
import { loadDemoProject } from '@/lib/tours/demo-kit';
import { useViewerStore } from '@/store';

/** No model at all: nothing loaded, nothing loading. A load in flight
 *  registers its placeholder model first, so the panel's own loading state
 *  takes over from there. */
export function useHasNoModel(): boolean {
  return useViewerStore((s) => s.models.size === 0 && !s.ifcDataStore && !s.loading);
}

interface PanelModelGateProps {
  id: WorkspacePanelId;
  mode: PanelModelGateMode;
  onClose: () => void;
  children: ReactNode;
}

export function PanelModelGate({ id, mode, onClose, children }: PanelModelGateProps) {
  const noModel = useHasNoModel();
  if (!noModel) return <>{children}</>;
  if (mode === 'banner') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <NoModelActions id={id} layout="banner" />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    );
  }
  return <NoModelPanelState id={id} onClose={onClose} />;
}

function NoModelPanelState({ id, onClose }: { id: WorkspacePanelId; onClose: () => void }) {
  const { t } = useTranslation();
  const def = getPanelDef(id);
  const Icon = def?.Icon ?? Building2;
  const title = t(panelTitleKey(id));
  return (
    <div className="flex h-full flex-col">
      {/* Side panels carry their own header and close; the bottom strip's tab already does. */}
      {def?.region === 'side' && (
        <div className="flex items-center gap-2 border-b p-3">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1 text-sm font-medium">{title}</span>
          <IconButton label={t('panelNoModel.close')} className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
      <EmptyState
        className="flex-1"
        icon={<Icon className="size-8" />}
        title={t('panelNoModel.title')}
        description={t('panelNoModel.description', { panel: title })}
        action={<NoModelActions id={id} layout="stack" />}
      />
    </div>
  );
}

function NoModelActions({ id, layout }: { id: WorkspacePanelId; layout: 'stack' | 'banner' }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  // One impression per mount, so the clicks below have a denominator.
  useEffect(() => {
    trackUiEvent('onboarding_surface', { surface: 'panel_empty_state', action: 'shown', panel_id: id });
  }, [id]);

  const loadSample = async (): Promise<void> => {
    trackUiEvent('onboarding_surface', { surface: 'panel_empty_state', action: 'load_sample', panel_id: id });
    setLoading(true);
    try {
      await loadDemoProject();
    } catch (err) {
      console.error('[panel-no-model] sample model failed to load', err);
      toast.error(t('viewportLighting.container.emptyState.loadDemo.failed'));
    } finally {
      setLoading(false);
    }
  };

  const openFile = (): void => {
    trackUiEvent('onboarding_surface', { surface: 'panel_empty_state', action: 'open_file', panel_id: id });
    window.dispatchEvent(new CustomEvent('ifc-lite:open-files'));
  };

  const sample = (
    <Button size="sm" className="gap-1.5" disabled={loading} onClick={() => { void loadSample(); }}>
      {loading ? <Spinner size="sm" /> : <Building2 className="h-3.5 w-3.5" aria-hidden="true" />}
      {t('viewportLighting.container.emptyState.loadDemo.button')}
    </Button>
  );
  const open = (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={openFile}>
      <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
      {t('viewportLighting.container.emptyState.openButton.open')}
    </Button>
  );

  if (layout === 'banner') {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t('panelNoModel.bannerDescription', { panel: t(panelTitleKey(id)) })}
        </span>
        {sample}
        {open}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      {sample}
      {open}
      <p className="max-w-[240px] text-2xs text-muted-foreground">{t('panelNoModel.dropHint')}</p>
    </div>
  );
}
