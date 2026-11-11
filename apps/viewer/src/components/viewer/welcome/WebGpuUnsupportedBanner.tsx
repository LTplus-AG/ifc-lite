/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The welcome screen's WebGPU-unsupported banner. Loaded lazily: only browsers
 * without a usable WebGPU adapter ever show it, so it stays out of the entry chunk.
 */

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/i18n';
import type { WebGPUStatus } from '@/hooks/useWebGPU';
import { WebGpuTroubleshootingDetails, webGpuBannerBlurb } from '../WebGpuTroubleshooting';

export default function WebGpuUnsupportedBanner({ webgpu }: { webgpu: WebGPUStatus }) {
  // `webGpuBannerBlurb` is a plain function, not a component — pass this
  // component's own `t` so the banner headline re-renders on a live locale
  // switch instead of reading the registry's non-reactive `resolve` default
  // (review on #5086).
  const { t } = useTranslation();
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  return (
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
  );
}
