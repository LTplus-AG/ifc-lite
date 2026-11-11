/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The welcome layer of the viewport: the start screen, the drop target and the
 * WebGPU-unsupported banner shown while no model is loaded. A layer over the
 * viewport rather than its replacement, so the viewer shell under it can stay
 * mounted across the first open (warm-shell.ts).
 */

import { useState, type ChangeEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Upload, AlertTriangle, ChevronDown, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { FILE_ACCEPT } from '@/services/supported-model-files';
import { WebGpuTroubleshootingDetails, webGpuBannerBlurb } from '../WebGpuTroubleshooting';
import { ViewportLoadErrorCard } from '../ViewportLoadErrorCard';
import { ViewportWelcome } from './ViewportWelcome';
import type { ViewportWelcomeCardProps } from '../ViewportWelcomeCard';
import type { WebGPUStatus } from '@/hooks/useWebGPU';

export interface ViewportWelcomeLayerProps extends Omit<ViewportWelcomeCardProps, 'webgpu'> {
  /** The full status: the unsupported banner reads its category and reason. */
  readonly webgpu: WebGPUStatus;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  readonly isDragging: boolean;
}

export function ViewportWelcomeLayer({ fileInputRef, onFileSelect, isDragging, webgpu, onOpenClick, onStartBlank, recentFiles, loadFile }: ViewportWelcomeLayerProps) {
  // `webGpuBannerBlurb` is a plain function, not a component — pass this
  // component's own `t` so the banner headline re-renders on a live locale
  // switch instead of reading the registry's non-reactive `resolve` default
  // (review on #5086).
  const { t } = useTranslation();
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  return (
    <div className="absolute inset-0 z-50 overflow-hidden bg-zinc-50 dark:bg-[#111219] text-zinc-900 dark:text-zinc-50">

      <input
        ref={fileInputRef}
        type="file"
        accept={FILE_ACCEPT}
        multiple
        onChange={onFileSelect}
        className="hidden"
      />

      {/* Drop overlay — full window, since the whole window is the drop target (#5845) */}
      {isDragging && createPortal(
        <div className="pointer-events-none fixed inset-0 z-50 bg-primary/10 backdrop-blur-[2px] flex items-center justify-center p-8">
          <div className="border-4 border-dashed border-primary bg-popover/90 p-12 max-w-2xl w-full text-center shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] transition-all">
            <Upload className="h-20 w-20 mx-auto text-primary mb-6" />
            <p className="text-3xl font-black uppercase tracking-tight text-primary">{t('viewportLighting.container.emptyState.dropOverlay.title')}</p>
          </div>
        </div>,
        document.body,
      )}

      {/* WebGPU Not Supported Banner — compact on mobile; tokens, not the hard-coded Tokyo Night hex (#5504). */}
      {!webgpu.checking && !webgpu.supported && (
        <div className="absolute top-0 left-0 right-0 z-40 max-h-[40vh] overflow-auto">
          {/* Hazard stripes background */}
          <div
            className="absolute inset-0 opacity-10"
            style={{ backgroundImage: 'repeating-linear-gradient(-45deg, transparent, transparent 10px, var(--color-destructive) 10px, var(--color-destructive) 20px)' }}
          />
          <div className="relative border-b-4 border-destructive bg-background px-4 py-5">
            <div className="max-w-3xl mx-auto flex items-start gap-4">
              {/* Icon container with brutalist frame */}
              <div className="flex-shrink-0 border-2 border-destructive p-2 bg-destructive/10">
                <AlertTriangle className="h-6 w-6 text-destructive" />
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="font-black text-lg uppercase tracking-wider text-destructive mb-1">
                  {t('viewportLighting.container.emptyState.webgpuBanner.heading')}
                </h3>
                <p className="font-mono text-sm text-foreground/80 leading-relaxed">
                  {webGpuBannerBlurb(webgpu.category, t)}
                  {webgpu.reason && (
                    <span className="block mt-1 text-muted-foreground">
                      {webgpu.reason}
                    </span>
                  )}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href="https://caniuse.com/webgpu"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono uppercase tracking-wide border border-border text-primary hover:border-primary hover:bg-primary/10 transition-colors"
                  >
                    {t('viewportLighting.container.emptyState.webgpuBanner.checkBrowserSupport')}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <span className="inline-flex items-center px-3 py-1 text-xs font-mono text-muted-foreground border border-border">
                    {t('viewportLighting.container.emptyState.webgpuBanner.supportedBrowsers')}
                  </span>
                </div>

                {/* Troubleshooting Section */}
                <button
                  onClick={() => setShowTroubleshooting(!showTroubleshooting)}
                  className="mt-4 flex items-center gap-2 text-xs font-mono uppercase tracking-wide text-amber-600 hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
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

      {/* One load-error card for every failed open attempt (#5851) —
          picker, drop, ?model= autoload — shown here too since a failure
          with nothing loaded yet renders THIS branch, not ViewportOverlays'. */}
      <ViewportLoadErrorCard />

      {/* Empty state content — mobile-optimized padding and scrollable.
          The scroll container must NOT center via justify-center: a flex
          child taller than an overflow-auto parent gets its top clipped
          beyond scroll reach (the logo used to vanish under the toolbar
          on short viewports). Instead an inner min-h-full column centers
          when there is room and grows scrollably from the top when not. */}
      <div className={`absolute inset-0 z-10 overflow-auto p-4 md:p-8 ${!webgpu.checking && !webgpu.supported ? 'pt-[min(40vh,14rem)] md:pt-[min(40vh,14rem)]' : ''}`}>
        <div className="min-h-full w-full flex flex-col items-center justify-center">

        {/* The start screen — its own modules (#5119) so this file's
            frozen size budget never has to grow for it. */}
        <ViewportWelcome
          webgpu={webgpu}
          onOpenClick={onOpenClick}
          onStartBlank={onStartBlank}
          recentFiles={recentFiles}
          loadFile={loadFile}
        />

        </div>
      </div>
    </div>
  );
}
