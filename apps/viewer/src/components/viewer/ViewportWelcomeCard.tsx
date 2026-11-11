/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The action column of the no-model start screen: heading, the three ways to
 * start (open a file, open from cloud, start blank), recent files, the
 * "no model handy?" samples and the privacy footnote. `ViewportWelcome` lays
 * it out next to the layered 3D mark, with the quiet learn/agent/shortcuts
 * line (`WelcomeFooterChips`) under both.
 *
 * One filled action, then everything else in the theme's plain ink and muted
 * ink (#8802 R6): the format list is ordinary text at the muted token, not a
 * dimmed monospace run, and the agent link left the sample list, where it
 * read as a third sample model.
 *
 * Opening your own model is the primary action. The demo project, which was
 * the first button from #5840 to the redesign, now sits with the other
 * samples: a visitor who arrives with a file should not have to read past a
 * sample to reach it, and one without a file still finds it one line down.
 *
 * Extracted from `ViewportContainer.tsx` (#5119): that file sits on the
 * module-size allowlist at a frozen budget.
 */

import { useEffect, useState } from 'react';
import { Upload, Cloud, PackagePlus, Building2, GitMerge, ShieldCheck } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import { loadDemoProjectVia } from '@/lib/tours/demo-kit';
import { MODEL_FILE_EXTENSIONS } from '@/services/supported-model-files';
import { useViewerStore } from '@/store';
import type { WebGPUStatus } from '@/hooks/useWebGPU';
import { getCachedFile, type RecentFileEntry } from '@/lib/recent-files';
import { WelcomeRecentFiles } from './welcome/WelcomeRecentFiles';
import { WebGpuDisabledCaption } from './WebGpuTroubleshooting';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';
import { trackUiEvent } from '@/lib/analytics';
import { onFieldTelemetry } from '@/lib/perf/fieldTelemetryLoader';
import { markLoadIntent } from '@/lib/load-intent';

/** Formats named under the actions, derived from the one extension list so
 *  the copy can never advertise less (or more) than the picker accepts. */
const MODEL_FORMATS_LABEL = MODEL_FILE_EXTENSIONS.join(' ');

const FOCUS = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const ACTION = `inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold whitespace-nowrap transition-colors ${FOCUS} disabled:cursor-not-allowed disabled:opacity-45`;
const PRIMARY = `${ACTION} bg-primary text-primary-foreground hover:bg-primary/90`;
const SECONDARY = `${ACTION} px-2.5 text-sm text-foreground hover:bg-muted hover:text-primary`;
const MUTED = 'text-muted-foreground';
const SAMPLE = `group flex min-w-0 items-baseline gap-2 rounded-md py-1.5 text-left ${FOCUS} disabled:cursor-not-allowed disabled:opacity-45`;
const SAMPLE_TITLE = 'flex items-center gap-1.5 text-sm font-semibold text-foreground group-enabled:group-hover:text-primary';

export interface ViewportWelcomeCardProps {
  webgpu: Pick<WebGPUStatus, 'supported' | 'checking'>;
  /** Open the file picker (File System Access API or the hidden input). */
  onOpenClick: () => void;
  /** Create an empty IFC and drop the user into the Model workspace's wall tool. */
  onStartBlank: () => void;
  recentFiles: RecentFileEntry[];
  /** The canonical load path (`useIfcLoader.loadFile`) for a cached recent file. */
  loadFile: (file: File) => Promise<void>;
}

export function ViewportWelcomeCard({ webgpu, onOpenClick, onStartBlank, recentFiles, loadFile }: ViewportWelcomeCardProps) {
  const { t } = useTranslation();
  const actionsDisabled = !webgpu.supported || webgpu.checking;
  const [demoLoading, setDemoLoading] = useState(false);
  // One impression per mount: the denominator for the clicks below.
  useEffect(() => { trackUiEvent('onboarding_surface', { surface: 'welcome_card', action: 'shown' }); }, []);
  // `viewer_boot` (#6961): navigation -> this drop target accepting a model.
  useEffect(() => {
    if (actionsDisabled) return;
    const at = performance.now();
    onFieldTelemetry((field) => field.noteDropTargetInteractive(at));
  }, [actionsDisabled]);

  // The sample the tours use ships with the viewer (#5840) and goes through
  // the same `loadFile` as every other open.
  const loadDemo = async () => {
    markLoadIntent(); // the sample is fetched before the load starts
    // Which way in a first visit takes; the panel empty state reports the same pair.
    trackUiEvent('onboarding_surface', { surface: 'welcome_card', action: 'load_sample' });
    setDemoLoading(true);
    try {
      await loadDemoProjectVia(loadFile);
    } catch (err) {
      console.error('[welcome] demo project failed to load', err);
      toast.error(t('viewportLighting.container.emptyState.loadDemo.failed'));
    } finally {
      setDemoLoading(false);
    }
  };

  const loadLayersDemo = () => {
    void import('@/lib/layers/demo-stack')
      .then((m) => m.loadDemoLayerStack())
      .catch((err: unknown) => {
        console.error('[welcome] layers demo stack failed to load', err);
        toast.error(t('viewportLighting.container.emptyState.loadDemo.failed'));
      });
  };

  const openRecent = async (file: RecentFileEntry) => {
    markLoadIntent(); // read from the recent-file cache before the load starts
    const cached = await getCachedFile(file);
    if (cached) {
      await loadFile(cached);
      return;
    }
    onOpenClick();
  };

  const hasRecent = recentFiles.length > 0;

  return (
    <div {...tourAnchor(TOUR_ANCHORS.emptyStateCard)} className="flex w-full max-w-[500px] flex-col">
      <h2 className="text-4xl font-extrabold leading-[1.05] tracking-[-0.035em] text-foreground md:text-5xl">
        {t('viewportLighting.container.emptyState.heading')}
      </h2>
      <p className={`mt-4 text-base leading-relaxed ${MUTED}`}>
        {hasRecent
          ? t('viewportLighting.container.emptyState.lead.returning')
          : t('viewportLighting.container.emptyState.lead.firstVisit')}
      </p>

      <div className="mt-7 flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => {
            trackUiEvent('onboarding_surface', { surface: 'welcome_card', action: 'open_file' });
            onOpenClick();
          }}
          disabled={actionsDisabled}
          className={`${PRIMARY} mr-1`}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          <span>
            {webgpu.checking
              ? t('viewportLighting.container.emptyState.openButton.checking')
              : webgpu.supported
                ? t('viewportLighting.container.emptyState.openButton.open')
                : t('viewportLighting.container.emptyState.openButton.required')}
          </span>
        </button>
        <button
          type="button"
          onClick={() => useViewerStore.getState().openPanelInHome('sources')}
          disabled={actionsDisabled}
          className={SECONDARY}
        >
          <Cloud className="h-4 w-4" aria-hidden="true" />
          {/* Provider-neutral: this opens the Cloud Sources panel, which
              lists every registered provider. */}
          <span>{t('viewportLighting.container.emptyState.openFromCloud')}</span>
        </button>
        <button type="button" onClick={onStartBlank} disabled={actionsDisabled} className={SECONDARY}>
          <PackagePlus className="h-4 w-4" aria-hidden="true" />
          <span>{t('viewportLighting.container.emptyState.startBlank')}</span>
        </button>
      </div>

      <p className={`mt-3 text-xs leading-relaxed ${MUTED}`}>
        {webgpu.supported ? (
          <>
            <span>{t('viewportLighting.container.emptyState.dragDropHint')}</span>{' '}
            {/* Its own line: a list that breaks mid-run reads as ragged noise. */}
            <span data-welcome-formats="" className="block">{MODEL_FORMATS_LABEL}</span>
          </>
        ) : <WebGpuDisabledCaption />}
      </p>

      <WelcomeRecentFiles files={recentFiles} disabled={actionsDisabled} onOpen={(file) => { void openRecent(file); }} />

      <section className="mt-8">
        <h3 className={`mb-1 text-xs font-medium ${MUTED}`}>{t('viewportLighting.container.emptyState.noModel.heading')}</h3>
        <div className="flex flex-col">
          <button type="button" onClick={() => { void loadDemo(); }} disabled={actionsDisabled || demoLoading} className={SAMPLE}>
            <span className={SAMPLE_TITLE}>
              {demoLoading ? <Spinner size="sm" /> : <Building2 className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>{t('viewportLighting.container.emptyState.loadDemo.button')}</span>
            </span>
            <span className={`text-xs ${MUTED}`}>{t('viewportLighting.container.emptyState.noModel.demoHint')}</span>
          </button>
          {/* The Layers demo stack (#1717). Desktop only: multi-file .ifcx
              layering is not a phone workflow. */}
          <button type="button" onClick={loadLayersDemo} disabled={actionsDisabled} className={`${SAMPLE} hidden md:flex`}>
            <span className={SAMPLE_TITLE}>
              <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('viewportLighting.container.emptyState.layersDemo')}</span>
            </span>
            <span className={`text-xs ${MUTED}`}>{t('viewportLighting.container.emptyState.noModel.layersHint')}</span>
          </button>
        </div>
      </section>

      {/* Privacy footnote (#5119). The SAME catalogue key as `PrivacyBanner`
          in KeyboardShortcutsDialog.tsx — one key, two call sites, pinned by
          ViewportWelcomeCard.privacy.test.tsx. Clicking deep-links to the
          About tab, where the WASM / F12-verification detail lives. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent(EVENT_SHOW_SHORTCUTS, { detail: { tab: 'about' } }))}
        title={t('viewportLighting.container.emptyState.privacyDetailsHint')}
        className={`group mt-8 flex min-h-6 items-center gap-1.5 self-start text-xs transition-colors hover:text-emerald-700 dark:hover:text-emerald-400 ${MUTED} ${FOCUS}`}
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <span>{t('keyboardShortcuts.privacy.banner')}</span>
      </button>
    </div>
  );
}
