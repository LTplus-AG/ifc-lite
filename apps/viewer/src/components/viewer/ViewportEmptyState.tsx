/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChangeEvent, DragEvent, RefObject } from 'react';
import { Upload, Command, AlertTriangle, ChevronDown, ExternalLink, Clock3, Sparkles, ArrowUpRight, PackagePlus, Cloud, GitMerge } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { TourInvite } from '@/components/tours/TourInvite';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { formatFileSize, getCachedFile, type RecentFileEntry } from '@/lib/recent-files';
import { FILE_ACCEPT } from '@/services/supported-model-files';
import { WebGpuDisabledCaption, WebGpuTroubleshootingDetails, webGpuBannerBlurb } from './WebGpuTroubleshooting';
import { FLOAT_SLOW_KEYFRAMES, GridPattern } from './ViewportEmptyStateChrome';
import type { WebGPUStatus } from '@/hooks/useWebGPU';

export interface ViewportEmptyStateProps {
  handleDragEnter: (e: DragEvent) => void;
  handleDragOver: (e: DragEvent) => void;
  handleDragLeave: (e: DragEvent) => void;
  handleDrop: (e: DragEvent) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  isDragging: boolean;
  webgpu: WebGPUStatus;
  showTroubleshooting: boolean;
  setShowTroubleshooting: (value: boolean) => void;
  handleOpenClick: () => void;
  handleStartBlank: () => void;
  recentFiles: RecentFileEntry[];
  loadFile: (file: File) => Promise<unknown>;
}

/** Start screen shown when no file is loaded — extracted from
 *  `ViewportContainer` (#5119) to stay under its module-size budget. */
export function ViewportEmptyState({
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  fileInputRef,
  handleFileSelect,
  isDragging,
  webgpu,
  showTroubleshooting,
  setShowTroubleshooting,
  handleOpenClick,
  handleStartBlank,
  recentFiles,
  loadFile,
}: ViewportEmptyStateProps) {
  const { t } = useTranslation();

  return (
    <div
      className="relative h-full w-full bg-white dark:bg-black text-zinc-900 dark:text-zinc-50 overflow-hidden"
      data-viewport
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <GridPattern />

      <input
        ref={fileInputRef}
        type="file"
        accept={FILE_ACCEPT}
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Drop overlay */}
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-50 bg-primary/10 backdrop-blur-[2px] flex items-center justify-center p-8">
          <div className="border-4 border-dashed border-primary bg-white/90 dark:bg-black/90 p-12 max-w-2xl w-full text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] transition-all">
            <Upload className="h-20 w-20 mx-auto text-primary mb-6" />
            <p className="text-3xl font-black uppercase tracking-tight text-primary">{t('viewportLighting.container.emptyState.dropOverlay.title')}</p>
          </div>
        </div>
      )}

      {/* WebGPU Not Supported Banner — compact on mobile */}
      {!webgpu.checking && !webgpu.supported && (
        <div className="absolute top-0 left-0 right-0 z-40 max-h-[40vh] overflow-auto">
          {/* Hazard stripes background */}
          <div
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage: `repeating-linear-gradient(
                -45deg,
                transparent,
                transparent 10px,
                #f7768e 10px,
                #f7768e 20px
              )`
            }}
          />
          <div className="relative border-b-4 border-[#f7768e] bg-[#1a1b26] dark:bg-[#1a1b26] px-4 py-5">
            <div className="max-w-3xl mx-auto flex items-start gap-4">
              {/* Icon container with brutalist frame */}
              <div className="flex-shrink-0 border-2 border-[#f7768e] p-2 bg-[#f7768e]/10">
                <AlertTriangle className="h-6 w-6 text-[#f7768e]" />
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="font-black text-lg uppercase tracking-wider text-[#f7768e] mb-1">
                  {t('viewportLighting.container.emptyState.webgpuBanner.heading')}
                </h3>
                <p className="font-mono text-sm text-[#a9b1d6] leading-relaxed">
                  {webGpuBannerBlurb(webgpu.category, t)}
                  {webgpu.reason && (
                    <span className="block mt-1 text-[#565f89]">
                      {webgpu.reason}
                    </span>
                  )}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href="https://caniuse.com/webgpu"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono uppercase tracking-wide border border-[#3b4261] text-[#7aa2f7] hover:border-[#7aa2f7] hover:bg-[#7aa2f7]/10 transition-colors"
                  >
                    {t('viewportLighting.container.emptyState.webgpuBanner.checkBrowserSupport')}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <span className="inline-flex items-center px-3 py-1 text-xs font-mono text-[#565f89] border border-[#3b4261]">
                    {t('viewportLighting.container.emptyState.webgpuBanner.supportedBrowsers')}
                  </span>
                </div>

                {/* Troubleshooting Section */}
                <button
                  onClick={() => setShowTroubleshooting(!showTroubleshooting)}
                  className="mt-4 flex items-center gap-2 text-xs font-mono uppercase tracking-wide text-[#ff9e64] hover:text-[#e0af68] transition-colors"
                >
                  <ChevronDown className={`h-4 w-4 transition-transform ${showTroubleshooting ? 'rotate-180' : ''}`} />
                  {showTroubleshooting
                    ? t('viewportLighting.container.emptyState.webgpuBanner.hideTroubleshooting')
                    : t('viewportLighting.container.emptyState.webgpuBanner.showTroubleshooting')}
                </button>

                {showTroubleshooting && (
                  <WebGpuTroubleshootingDetails category={webgpu.category} />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty state content — scrollable, mobile-optimized padding. Must NOT
          center via justify-center: an overflow-auto parent shorter than its
          flex child clips the top (the logo used to vanish under the
          toolbar). An inner min-h-full column centers when there's room and
          grows scrollably from the top when not. */}
      <div className="absolute inset-0 z-10 overflow-auto p-4 md:p-8">
        <div className="min-h-full w-full flex flex-col items-center justify-center">

        {/* Main Card */}
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
          {/* Track 1 — open / drag */}
          <button
            onClick={() => { void handleOpenClick(); }}
            disabled={!webgpu.supported || webgpu.checking}
            className={`group w-full flex items-center justify-center gap-3 px-6 py-3 font-mono text-sm border transition-all ${
              !webgpu.supported || webgpu.checking
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

          <p className="mt-2.5 text-[11px] font-mono text-center text-zinc-400 dark:text-[#565f89]">
            {webgpu.supported ? t('viewportLighting.container.emptyState.dragDropHint') : <WebGpuDisabledCaption />}
          </p>

          {/* Subtle "or" rule — anchors the symmetry between the two tracks */}
          <div className="mt-5 mb-5 w-full flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-400 dark:text-[#565f89]">
            <span className="h-px flex-1 bg-zinc-200 dark:bg-[#3b4261]" />
            <span>{t('viewportLighting.container.emptyState.orDivider')}</span>
            <span className="h-px flex-1 bg-zinc-200 dark:bg-[#3b4261]" />
          </div>

          {/* Track 2 — two peer pills, both answering "I don't have a file to open": start blank, or hand the wheel to an LLM via MCP. */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => { void handleStartBlank(); }}
              disabled={!webgpu.supported || webgpu.checking}
              className={`group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] border border-dashed transition-all ${
                !webgpu.supported || webgpu.checking
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
              disabled={!webgpu.supported || webgpu.checking}
              className={`group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] border border-dashed transition-all ${
                !webgpu.supported || webgpu.checking
                  ? 'border-zinc-200 dark:border-[#3b4261]/50 text-zinc-300 dark:text-[#565f89]/50 cursor-not-allowed'
                  : 'border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary cursor-pointer'
              }`}
            >
              <Cloud className="h-3 w-3 transition-transform group-enabled:group-hover:-translate-y-0.5" />
              {/* Provider-neutral: opens the Cloud Sources panel, which lists every registered provider (naming one stopped being accurate at the second). */}
              <span>{t('viewportLighting.container.emptyState.openFromCloud')}</span>
            </button>
            <a
              href="/mcp"
              className="group inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] border border-dashed border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#7a82a5] hover:border-primary hover:text-primary transition-all cursor-pointer"
            >
              <Sparkles className="h-3 w-3 transition-transform group-hover:-translate-y-0.5" />
              <span>{t('viewportLighting.container.emptyState.driveWithLlm')}</span>
              <ArrowUpRight className="h-2.5 w-2.5 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </a>
          </div>

          <p className="mt-1.5 text-[10px] font-mono text-center text-zinc-400 dark:text-[#565f89]">
            {t('viewportLighting.container.emptyState.footerCaption')}
          </p>

          {/* Privacy assurance (#5119): same 'keyboardShortcuts.privacy.banner' key as the About-tab PrivacyBanner, so the two surfaces can't drift. A footnote, not a second CTA. */}
          <p className="mt-1.5 text-[11px] font-mono text-center text-zinc-400 dark:text-[#565f89]">
            {t('keyboardShortcuts.privacy.banner')}
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
                      void handleOpenClick();
                    }}
                    className="flex items-center justify-between gap-3 border border-zinc-200 bg-zinc-50 px-3 py-2 text-left transition-colors hover:border-primary hover:text-primary dark:border-[#3b4261] dark:bg-[#1f2335] dark:hover:border-primary"
                  >
                    <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-zinc-400 dark:text-[#565f89]">
                      {formatFileSize(file.size)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Old Select/Filter/Analyze grid dropped: repeated toolbar affordances, no action, pushed the card off-screen. */}
        {/* Moonshot callout (#1717): Layer PRs are brand new - nobody knows to multi-drop .ifcx files, so the welcome screen sells the demo. */}
        <button
          type="button"
          onClick={() => {
            void import('@/lib/layers/demo-stack')
              .then((m) => m.loadDemoLayerStack())
              .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
          }}
          className="group mt-6 hidden md:flex items-center gap-3 max-w-3xl w-full p-3 bg-zinc-100 dark:bg-[#1f2335] border border-primary/40 hover:border-primary transition-colors text-left"
        >
          <div className="p-2 bg-white dark:bg-[#16161e] border border-zinc-300 dark:border-[#3b4261] text-primary">
            <GitMerge className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-bold uppercase text-sm tracking-wide text-zinc-900 dark:text-[#a9b1d6]">
              <span className="mr-2 rounded-sm bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">{t('viewportLighting.container.emptyState.layersPromo.badge')}</span>
              {t('viewportLighting.container.emptyState.layersPromo.title')}
            </h3>
            <p className="text-xs font-mono text-zinc-500 dark:text-[#565f89]">
              {t('viewportLighting.container.emptyState.layersPromo.description')}
            </p>
          </div>
          <span className="text-xs font-mono font-bold text-primary group-hover:translate-x-0.5 transition-transform">
            {t('viewportLighting.container.emptyState.layersPromo.cta')}
          </span>
        </button>

        {/* Footer chips (desktop-only): discovery link, shortcuts cue. IN FLOW not absolute — an absolutely-anchored chip rode the scroll (#1736). */}
        <div className="mt-10 hidden w-full max-w-3xl items-center justify-between gap-4 md:flex">
          <a
            href="https://ifclite.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2 text-xs font-mono px-3 py-1.5 bg-zinc-100 dark:bg-[#1f2335] border border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#565f89] hover:border-primary hover:text-primary transition-colors"
          >
            <span>{t('viewportLighting.container.emptyState.footer.discoverPrompt')}</span>
            <span className="font-bold text-primary group-hover:translate-x-0.5 transition-transform">{t('viewportLighting.container.emptyState.footer.discoverLink')}</span>
          </a>
          <div className="flex items-center gap-2 text-xs font-mono px-3 py-1.5 bg-zinc-100 dark:bg-[#1f2335] border border-zinc-300 dark:border-[#3b4261] text-zinc-500 dark:text-[#565f89]">
            <Command className="h-3 w-3" />
            <span>{t('viewportLighting.container.emptyState.footer.shortcutsLabel')}</span>
            <span className="px-1.5 ml-1 font-bold text-primary bg-primary/20">?</span>
          </div>
        </div>

        </div>
      </div>
    </div>
  );
}
