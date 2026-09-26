/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-mode legend for the point-cloud panel.
 *
 * Renders only when the active colour mode benefits from a ramp legend
 * (intensity / height); RGB and Solid don't need one, and the
 * classification palette is covered by `PointCloudClasses` (#1783),
 * whose per-class rows double as the legend with counts and toggles.
 * The ramps here MUST stay in sync with `point-shader.wgsl.ts` —
 * any colour change in the shader has to come back to this file.
 */

import type { PointColorModeUi } from '@/store/slices/pointCloudSlice';
import { useTranslation } from '@/i18n';

const HEIGHT_GRADIENT =
  'linear-gradient(to right, '
  + 'rgb(26,51,217), '   // 0.10, 0.20, 0.85
  + 'rgb(26,217,217), '  // 0.10, 0.85, 0.85
  + 'rgb(51,217,51), '   // 0.20, 0.85, 0.20
  + 'rgb(242,242,51), '  // 0.95, 0.95, 0.20
  + 'rgb(242,51,26))';   // 0.95, 0.20, 0.10

export interface PointCloudLegendProps {
  colorMode: PointColorModeUi;
}

export function PointCloudLegend({ colorMode }: PointCloudLegendProps) {
  const { t } = useTranslation();
  if (colorMode === 'intensity') {
    return (
      <div className="flex flex-col gap-0.5 mt-1">
        <span className="text-2xs uppercase text-muted-foreground tracking-wider">{t('pointCloudLegend.intensityLabel')}</span>
        <div
          className="h-2 rounded-sm border border-foreground/10"
          style={{ background: 'linear-gradient(to right, rgb(0,0,0), rgb(255,255,255))' }}
          aria-label={t('pointCloudLegend.intensityRampAriaLabel')}
        />
        <div className="flex justify-between text-2xs text-muted-foreground">
          <span>{t('pointCloudLegend.low')}</span>
          <span>{t('pointCloudLegend.high')}</span>
        </div>
      </div>
    );
  }

  if (colorMode === 'height') {
    return (
      <div className="flex flex-col gap-0.5 mt-1">
        <span className="text-2xs uppercase text-muted-foreground tracking-wider">{t('pointCloudLegend.heightLabel')}</span>
        <div
          className="h-2 rounded-sm border border-foreground/10"
          style={{ background: HEIGHT_GRADIENT }}
          aria-label={t('pointCloudLegend.heightRampAriaLabel')}
        />
        <div className="flex justify-between text-2xs text-muted-foreground">
          <span>{t('pointCloudLegend.low')}</span>
          <span>{t('pointCloudLegend.high')}</span>
        </div>
      </div>
    );
  }

  return null;
}
