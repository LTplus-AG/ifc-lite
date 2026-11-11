/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The welcome layer of the viewport: the start screen, the drop target and the
 * WebGPU-unsupported banner shown while no model is loaded. A layer over the
 * viewport rather than its replacement, so the viewer shell under it can stay
 * mounted across the first open (warm-shell.ts).
 */

import { lazy, Suspense, type ChangeEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Upload } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { FILE_ACCEPT } from '@/services/supported-model-files';
import { ViewportLoadErrorCard } from '../ViewportLoadErrorCard';
import { ViewportWelcome } from './ViewportWelcome';
import type { ViewportWelcomeCardProps } from '../ViewportWelcomeCard';
import type { WebGPUStatus } from '@/hooks/useWebGPU';

const WebGpuUnsupportedBanner = lazy(() => import('./WebGpuUnsupportedBanner'));

export interface ViewportWelcomeLayerProps extends Omit<ViewportWelcomeCardProps, 'webgpu'> {
  /** The full status: the unsupported banner reads its category and reason. */
  readonly webgpu: WebGPUStatus;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onFileSelect: (e: ChangeEvent<HTMLInputElement>) => void;
  readonly isDragging: boolean;
}

export function ViewportWelcomeLayer({ fileInputRef, onFileSelect, isDragging, webgpu, onOpenClick, onStartBlank, recentFiles, loadFile }: ViewportWelcomeLayerProps) {
  const { t } = useTranslation();
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

      {/* WebGPU Not Supported Banner — loaded only on browsers that need it. */}
      {!webgpu.checking && !webgpu.supported && (
        <Suspense fallback={null}><WebGpuUnsupportedBanner webgpu={webgpu} /></Suspense>
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
