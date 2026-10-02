/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model-dependent workspace panel opened on an empty viewer (#6720).
 *
 * Field replays: sessions that never load a model still open panels, Lens,
 * Charts, Zones, Presentation, Environment, Model and more, and get the
 * panel's controls over nothing (or one grey line). Only the viewport's
 * welcome card offered a way in, and an open bottom panel pushes that card
 * half out of view. So the panel itself now says what it is for and offers
 * the same two ways in as the welcome card, under the same labels: the tour
 * demo project (through the canonical `loadFile`, via the
 * `ifc-lite:load-file` bus) and the file picker (`ifc-lite:open-files`,
 * dispatched inside the click so Chromium's picker keeps user activation).
 *
 * `takeover` replaces a panel whose whole content is model-derived;
 * `banner` puts one quiet line above a panel that also has model-independent
 * work (author a list, import a schedule). Which panel gets which is
 * `panelModelGateMode` in `lib/panels/registry.ts`.
 *
 * Banner mode renders the SAME wrapper with and without a model and only
 * toggles the line: swapping the parent element when a load starts would
 * remount the panel and drop whatever the user authored before loading
 * (the #4243 class).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Building2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useTranslation, type TranslationKey } from '@/i18n';
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

/** What each panel is for, in one line; the header already names it. */
const TAKEOVER_LINES: Partial<Record<WorkspacePanelId, TranslationKey>> = {
  lens: 'panelNoModel.line.lens',
  charts: 'panelNoModel.line.charts',
  environment: 'panelNoModel.line.environment',
  presentation: 'panelNoModel.line.presentation',
  drawing: 'panelNoModel.line.drawing',
  model: 'panelNoModel.line.model',
  changes: 'panelNoModel.line.changes',
  changeSets: 'panelNoModel.line.changeSets',
  cost: 'panelNoModel.line.cost',
  placement: 'panelNoModel.line.placement',
  loadReport: 'panelNoModel.line.loadReport',
};

/** What already works without a model, and what waits for one. */
const BANNER_LINES: Partial<Record<WorkspacePanelId, TranslationKey>> = {
  lists: 'panelNoModel.banner.lists',
  document: 'panelNoModel.banner.document',
  flow: 'panelNoModel.banner.flow',
  gantt: 'panelNoModel.banner.gantt',
  zones: 'panelNoModel.banner.zones',
};

interface PanelModelGateProps {
  id: WorkspacePanelId;
  mode: PanelModelGateMode;
  onClose: () => void;
  children: ReactNode;
}

export function PanelModelGate({ id, mode, onClose, children }: PanelModelGateProps) {
  const noModel = useHasNoModel();
  if (mode === 'banner') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {noModel && <NoModelBanner id={id} />}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    );
  }
  return noModel ? <NoModelPanelState id={id} onClose={onClose} /> : <>{children}</>;
}

/** Load the demo project / open the picker, reported by registry id only. */
function useNoModelActions(id: WorkspacePanelId) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  // One impression per mount, so the clicks have a denominator.
  useEffect(() => {
    trackUiEvent('onboarding_surface', { surface: 'panel_empty_state', action: 'shown', panel_id: id });
  }, [id]);

  const loadSample = async (): Promise<void> => {
    trackUiEvent('onboarding_surface', { surface: 'panel_empty_state', action: 'load_sample', panel_id: id });
    setLoading(true);
    try {
      await loadDemoProject();
    } catch (err) {
      console.error('[panel-no-model] demo project failed to load', err);
      toast.error(t('viewportLighting.container.emptyState.loadDemo.failed'));
    } finally {
      setLoading(false);
    }
  };
  const openFile = (): void => {
    trackUiEvent('onboarding_surface', { surface: 'panel_empty_state', action: 'open_file', panel_id: id });
    window.dispatchEvent(new CustomEvent('ifc-lite:open-files'));
  };
  return { loading, loadSample, openFile };
}

function NoModelPanelState({ id, onClose }: { id: WorkspacePanelId; onClose: () => void }) {
  const { t } = useTranslation();
  const isMobile = useViewerStore((s) => s.isMobile);
  const { loading, loadSample, openFile } = useNoModelActions(id);
  const def = getPanelDef(id);
  const Icon = def?.Icon ?? Building2;
  return (
    <div className="flex h-full flex-col">
      {/* Side panels draw their own header and close, in this style (Zones,
          Environment, Cost, Changes ...); the bottom strip's tab and the
          mobile sheet already carry one. */}
      {def?.region === 'side' && !isMobile && (
        <div className="flex items-center gap-2 border-b p-3">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1 text-sm font-medium">{t(panelTitleKey(id))}</span>
          <IconButton label={t('panelNoModel.close')} className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
      <EmptyState
        className="flex-1"
        icon={<Icon className="size-8" />}
        title={t('panelNoModel.title')}
        description={t(TAKEOVER_LINES[id] ?? 'panelNoModel.description')}
        action={
          <div className="flex flex-col items-center gap-2">
            <Button size="sm" className="gap-1.5" disabled={loading} onClick={() => { void loadSample(); }}>
              {loading ? <Spinner size="sm" /> : <Building2 className="h-3.5 w-3.5" aria-hidden="true" />}
              {t('viewportLighting.container.emptyState.loadDemo.button')}
            </Button>
            <Button variant="outline" size="sm" onClick={openFile}>
              {t('viewportLighting.container.emptyState.openButton.open')}
            </Button>
            <p className="max-w-[240px] text-2xs text-muted-foreground">{t('panelNoModel.dropHint')}</p>
          </div>
        }
      />
    </div>
  );
}

/** One muted line with two text links: the panel's own work stays primary. */
function NoModelBanner({ id }: { id: WorkspacePanelId }) {
  const { t } = useTranslation();
  const { loading, loadSample, openFile } = useNoModelActions(id);
  const link = 'font-medium text-foreground underline underline-offset-2 hover:text-primary disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
  return (
    <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
      {t(BANNER_LINES[id] ?? 'panelNoModel.description')}{' '}
      <button type="button" className={link} disabled={loading} onClick={() => { void loadSample(); }}>
        {t('viewportLighting.container.emptyState.loadDemo.button')}
      </button>
      <span aria-hidden="true"> · </span>
      <button type="button" className={link} onClick={openFile}>
        {t('viewportLighting.container.emptyState.openButton.open')}
      </button>
    </p>
  );
}
