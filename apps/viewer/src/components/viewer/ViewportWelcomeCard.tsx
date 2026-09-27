/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The welcome card of the no-model start screen — logo, tagline, the
 * two-track action area, recent files and the privacy footnote.
 *
 * Extracted from `ViewportContainer.tsx` (#5119): that file sits on the
 * module-size allowlist at a frozen budget, so the one line every new user
 * asks about first ("does my model get uploaded?") had nowhere to land
 * without growing it. Living here it is also testable on its own.
 */

import { useState } from 'react';
import { Upload, Clock3, Sparkles, ArrowUpRight, PackagePlus, Cloud, ShieldCheck, Building2, GitMerge } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import { fetchDemoProjectFile } from '@/lib/tours/demo-kit';
import { MODEL_FILE_EXTENSIONS } from '@/services/supported-model-files';
import { useViewerStore } from '@/store';
import type { WebGPUStatus } from '@/hooks/useWebGPU';
import { formatFileSize, getCachedFile, type RecentFileEntry } from '@/lib/recent-files';
import { WebGpuDisabledCaption } from './WebGpuTroubleshooting';
import { TourInvite } from '@/components/tours/TourInvite';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { EVENT_SHOW_SHORTCUTS } from '@/lib/tours/events';

/** Plain CSS text, not UI copy — kept as a module-level constant (rather than
 *  an inline `<style>{`…`}</style>` template literal) so the i18n literal
 *  gate, which only inspects JSX-child string LITERALS, never mistakes a
 *  keyframe declaration for translatable prose. */
/** Formats named under the Open button, derived from the one extension list
 *  so the copy can never advertise less (or more) than the picker accepts. */
const MODEL_FORMATS_LABEL = MODEL_FILE_EXTENSIONS.join(' ');

const FLOAT_SLOW_KEYFRAMES = `
  @keyframes float-slow {
    0%, 100% { transform: translateY(0px) rotate(0deg); }
    50% { transform: translateY(-6px) rotate(1deg); }
  }
  .animate-float-slow {
    animation: float-slow 5s ease-in-out infinite;
  }
`;

export interface ViewportWelcomeCardProps {
  webgpu: Pick<WebGPUStatus, 'supported' | 'checking'>;
  /** Open the file picker (File System Access API or the hidden input). */
  onOpenClick: () => void;
  /** Create an empty IFC and drop the user into the add-element tool. */
  onStartBlank: () => void;
  recentFiles: RecentFileEntry[];
  /** The canonical load path (`useIfcLoader.loadFile`) for a cached recent file. */
  loadFile: (file: File) => Promise<void>;
}

export function ViewportWelcomeCard({ webgpu, onOpenClick, onStartBlank, recentFiles, loadFile }: ViewportWelcomeCardProps) {
  const { t } = useTranslation();
  const actionsDisabled = !webgpu.supported || webgpu.checking;
  const [demoLoading, setDemoLoading] = useState(false);

  // The first-run primary action (#5840): 43% of sessions never loaded a
  // model, and the sample the tours use already ships with the viewer. It
  // goes through the same `loadFile` as every other open.
  const loadDemo = async () => {
    setDemoLoading(true);
    try {
      await loadFile(await fetchDemoProjectFile());
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

  return (
    <div {...tourAnchor(TOUR_ANCHORS.emptyStateCard)} className="max-w-md w-full bg-white dark:bg-[#16161e] border border-zinc-300 dark:border-[#3b4261] p-8 flex flex-col items-center transition-transform hover:-translate-y-1 duration-200 shadow-lg">

      <style>{FLOAT_SLOW_KEYFRAMES}</style>

      {/* Logo Section */}
      <div className="mb-10 relative group/logo cursor-pointer">
        {/* Back Layer */}
        <div className="absolute -inset-6 bg-zinc-100 dark:bg-[#1f2335] -rotate-3 z-0 border border-zinc-300 dark:border-[#3b4261] transition-all duration-500 group-hover/logo:rotate-0 group-hover/logo:scale-110" />

        {/* Middle Layer - accent on hover */}
        <div className="absolute -inset-6 border border-primary z-0 opacity-0 scale-95 rotate-3 transition-all duration-500 delay-75 group-hover/logo:opacity-40 group-hover/logo:rotate-6 group-hover/logo:scale-105" />

        {/* Logo Container */}
        <div className="relative z-10 animate-float-slow transition-transform duration-300 group-hover/logo:scale-110">
          <img
            src="/logo.png"
            alt={t('viewportLighting.container.emptyState.logoAlt')}
            className="h-28 w-auto drop-shadow-lg"
          />
        </div>
      </div>

      <h2 className="text-3xl font-black tracking-tighter text-center mb-2 text-zinc-900 dark:text-[#a9b1d6]">
        {t('viewportLighting.container.emptyState.title')}
      </h2>
      <p className="text-zinc-500 dark:text-[#565f89] font-mono text-sm text-center mb-8 border-b border-zinc-200 dark:border-[#3b4261] pb-4 w-full">
        {t('viewportLighting.container.emptyState.tagline')}
      </p>

      {/*
        Two-track action area: a primary "open file" track and a
        secondary "drive with LLM" track sit in mirrored slots — same
        width, same vertical rhythm, each followed by its own caption
        line. Reads as one balanced composition instead of a primary
        CTA + a tacked-on link, while keeping the file-open path
        visually dominant via the filled-on-hover treatment.
      */}
      {/* Track 1 — the demo project is the primary action for a first
          visit (#5840); opening your own file sits right under it. */}
      <button
        type="button"
        onClick={() => { void loadDemo(); }}
        disabled={actionsDisabled || demoLoading}
        className={`group w-full flex items-center justify-center gap-3 px-6 py-3 font-mono text-sm font-bold border transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          actionsDisabled
            ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
            : 'border-primary bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
        }`}
      >
        {demoLoading
          ? <Spinner size="md" />
          : <Building2 className="h-4 w-4" aria-hidden="true" />}
        <span>{t('viewportLighting.container.emptyState.loadDemo.button')}</span>
      </button>
      <p className="mt-1.5 mb-3 text-2xs font-mono text-center text-zinc-400 dark:text-[#565f89]">
        {webgpu.supported ? t('viewportLighting.container.emptyState.loadDemo.caption') : <WebGpuDisabledCaption />}
      </p>

      <button
        type="button"
        onClick={onOpenClick}
        disabled={actionsDisabled}
        className={`group w-full flex items-center justify-center gap-3 px-6 py-3 font-mono text-sm border transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          actionsDisabled
            ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
            : 'border-zinc-300 dark:border-[#3b4261] text-zinc-600 dark:text-[#a9b1d6] hover:border-primary hover:text-primary cursor-pointer'
        }`}
      >
        <Upload className={`h-4 w-4 transition-transform ${webgpu.supported ? 'group-hover:-translate-y-0.5' : ''}`} />
        <span>
          {webgpu.checking
            ? t('viewportLighting.container.emptyState.openButton.checking')
            : webgpu.supported
              ? t('viewportLighting.container.emptyState.openButton.open')
              : t('viewportLighting.container.emptyState.openButton.required')}
        </span>
      </button>

      {webgpu.supported && (
        <p className="mt-2.5 text-2xs font-mono text-center text-zinc-400 dark:text-[#565f89]">
          <span>{t('viewportLighting.container.emptyState.dragDropHint')}</span>
          <span className="block mt-0.5 text-2xs opacity-80">{MODEL_FORMATS_LABEL}</span>
        </p>
      )}

      {/* Subtle "or" rule — anchors the symmetry between the two tracks */}
      <div className="mt-5 mb-5 w-full flex items-center gap-3 text-2xs font-mono uppercase tracking-[0.22em] text-zinc-400 dark:text-[#565f89]">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-[#3b4261]" />
        <span>{t('viewportLighting.container.emptyState.orDivider')}</span>
        <span className="h-px flex-1 bg-zinc-200 dark:bg-[#3b4261]" />
      </div>

      {/* Track 2 — two peer pills that both answer "I don't have a
          file to open": start a fresh project, or hand the wheel to
          an LLM via MCP. Both share the same dashed-pill silhouette
          so they read as siblings, with the file-open CTA above
          staying visually dominant. */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onStartBlank}
          disabled={actionsDisabled}
          className={`group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-2xs border border-dashed transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            actionsDisabled
              ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
              : 'border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary cursor-pointer'
          }`}
        >
          <PackagePlus className="h-3 w-3 transition-transform group-enabled:group-hover:-translate-y-0.5" />
          <span>{t('viewportLighting.container.emptyState.startBlank')}</span>
        </button>
        <button
          type="button"
          onClick={() => useViewerStore.getState().openPanelInHome('sources')}
          disabled={actionsDisabled}
          className={`group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-2xs border border-dashed transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            actionsDisabled
              ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
              : 'border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary cursor-pointer'
          }`}
        >
          <Cloud className="h-3 w-3 transition-transform group-enabled:group-hover:-translate-y-0.5" />
          {/* Provider-neutral: this opens the Cloud Sources panel, which
              lists every registered provider. Naming one vendor on the
              front door stopped being accurate at the second provider. */}
          <span>{t('viewportLighting.container.emptyState.openFromCloud')}</span>
        </button>
        <a
          href="/mcp"
          className="group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-2xs border border-dashed border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Sparkles className="h-3 w-3 transition-transform group-hover:-translate-y-0.5" />
          <span>{t('viewportLighting.container.emptyState.driveWithLlm')}</span>
          <ArrowUpRight className="h-2.5 w-2.5 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </a>
        {/* The Layers demo stack (#1717) — folded into the card as a peer
            pill instead of a second floating promo (#5840). Desktop only:
            multi-file .ifcx layering is not a phone workflow. */}
        <button
          type="button"
          onClick={loadLayersDemo}
          disabled={actionsDisabled}
          className={`group hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-2xs border border-dashed transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            actionsDisabled
              ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
              : 'border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary cursor-pointer'
          }`}
        >
          <GitMerge className="h-3 w-3 transition-transform group-enabled:group-hover:-translate-y-0.5" />
          <span>{t('viewportLighting.container.emptyState.layersDemo')}</span>
        </button>
      </div>

      <p className="mt-1.5 text-2xs font-mono text-center text-zinc-400 dark:text-[#565f89]">
        {t('viewportLighting.container.emptyState.footerCaption')}
      </p>

      {/* First-run tour invite — needs loadFile, so it shares the
          WebGPU gate of every other action on this card. */}
      {webgpu.supported && !webgpu.checking && <TourInvite />}

      {recentFiles.length > 0 && (
        <div className="mt-6 w-full border-t border-zinc-200 dark:border-[#3b4261] pt-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-zinc-400 dark:text-[#565f89]">
            <Clock3 className="h-3.5 w-3.5" />
            <span>{t('viewportLighting.container.emptyState.recentFiles.heading')}</span>
          </div>
          <div className="flex flex-col gap-2">
            {recentFiles.map((file) => (
              <button
                key={`${file.name}-${file.timestamp}`}
                type="button"
                onClick={async () => {
                  const cached = await getCachedFile(file);
                  if (cached) {
                    await loadFile(cached);
                    return;
                  }
                  onOpenClick();
                }}
                className="flex items-center justify-between gap-3 border border-zinc-200 bg-zinc-50 px-3 py-2 text-left transition-colors hover:border-primary hover:text-primary dark:border-[#3b4261] dark:bg-[#1f2335] dark:hover:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
                <span className="shrink-0 font-mono text-2xs uppercase tracking-wide text-zinc-400 dark:text-[#565f89]">
                  {formatFileSize(file.size)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Privacy footnote (#5119). "Does my model get uploaded?" is the
          first question a new user asks, and the answer used to sit three
          interactions deep (`?` → About → expand). It reads as a quiet
          footer under the composition, not a third CTA. The SAME catalogue
          key as `PrivacyBanner` in KeyboardShortcutsDialog.tsx — one key,
          two call sites, pinned by ViewportWelcomeCard.privacy.test.tsx so
          the two surfaces can never state different things. The WASM /
          F12-verification detail is deliberately NOT duplicated here:
          clicking deep-links to the About tab where it already lives. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent(EVENT_SHOW_SHORTCUTS, { detail: { tab: 'about' } }))}
        title={t('viewportLighting.container.emptyState.privacyDetailsHint')}
        className="group mt-6 w-full border-t border-zinc-200 dark:border-[#3b4261] pt-3 flex items-center justify-center gap-1.5 text-2xs font-mono text-zinc-400 dark:text-[#565f89] hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-500" />
        <span>{t('keyboardShortcuts.privacy.banner')}</span>
      </button>
    </div>
  );
}
