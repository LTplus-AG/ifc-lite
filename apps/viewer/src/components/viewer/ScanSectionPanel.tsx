/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ScanSectionPanel - controls for the point-cloud scan overlay on the 2D
 * section view (issue #1805).
 *
 * A thin band of the loaded point cloud(s) around the active section plane,
 * projected into drawing space and drawn as dots. Slide-in panel matching
 * the DXF underlay / sheet setup panels' shape.
 */

import React from 'react';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import {
  SCAN_SECTION_THICKNESS_MIN,
  SCAN_SECTION_THICKNESS_MAX,
} from '@/hooks/scanSectionMath';

interface ScanSectionPanelProps {
  hasPointCloud: boolean;
  totalInBand: number;
  renderedCount: number;
}

export function ScanSectionPanel({
  hasPointCloud,
  totalInBand,
  renderedCount,
}: ScanSectionPanelProps): React.ReactElement {
  const { t } = useTranslation();
  const displayOptions = useViewerStore((s) => s.drawing2DDisplayOptions);
  const updateDisplayOptions = useViewerStore((s) => s.updateDrawing2DDisplayOptions);

  const { showScanSection, scanSectionThickness, scanSectionOpacity, scanSectionIncludeInExport } = displayOptions;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* The inspector tab (#5495) carries the title; no panel-owned header. */}
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-xs font-medium">{t('scanSectionPanel.showScanPointsLabel')}</span>
          <input
            type="checkbox"
            checked={showScanSection}
            onChange={(e) => updateDisplayOptions({ showScanSection: e.target.checked })}
            className="accent-teal-600"
          />
        </label>

        {!hasPointCloud && (
          <p className="text-xs text-muted-foreground px-0.5">
            {t('scanSectionPanel.noPointCloudMessage')}
          </p>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor="scan-section-thickness" className="text-2xs text-muted-foreground">
            {t('scanSectionPanel.bandThicknessLabel', {
              value: scanSectionThickness >= 1
                ? `${scanSectionThickness.toFixed(2)} m`
                : `${Math.round(scanSectionThickness * 1000)} mm`,
            })}
          </Label>
          <input
            id="scan-section-thickness"
            type="range"
            min={SCAN_SECTION_THICKNESS_MIN}
            max={SCAN_SECTION_THICKNESS_MAX}
            step={0.01}
            value={scanSectionThickness}
            onChange={(e) => updateDisplayOptions({ scanSectionThickness: Number(e.target.value) })}
            className="h-1 accent-teal-600 cursor-pointer"
            title={t('scanSectionPanel.thicknessSliderTitle')}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="scan-section-opacity" className="text-2xs text-muted-foreground">
            {t('scanSectionPanel.dotOpacityLabel', { percent: Math.round(scanSectionOpacity * 100) })}
          </Label>
          <input
            id="scan-section-opacity"
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={scanSectionOpacity}
            onChange={(e) => updateDisplayOptions({ scanSectionOpacity: Number(e.target.value) })}
            className="h-1 accent-teal-600 cursor-pointer"
          />
        </div>

        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-xs">{t('scanSectionPanel.includeInExportLabel')}</span>
          <input
            type="checkbox"
            checked={scanSectionIncludeInExport}
            onChange={(e) => updateDisplayOptions({ scanSectionIncludeInExport: e.target.checked })}
            className="accent-teal-600"
          />
        </label>

        {hasPointCloud && (
          <p className="text-2xs text-muted-foreground border-t pt-2">
            {!showScanSection
              ? t('scanSectionPanel.overlayHiddenMessage')
              : renderedCount >= totalInBand
                ? t('scanSectionPanel.showingAllMessage', { total: totalInBand.toLocaleString() })
                : t('scanSectionPanel.showingPartialMessage', {
                    rendered: renderedCount.toLocaleString(),
                    total: totalInBand.toLocaleString(),
                  })}
          </p>
        )}
      </div>
    </div>
  );
}

export default ScanSectionPanel;
