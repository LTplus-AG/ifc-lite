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
import { ScanLine, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/store';
import {
  SCAN_SECTION_THICKNESS_MIN,
  SCAN_SECTION_THICKNESS_MAX,
} from '@/hooks/scanSectionMath';

interface ScanSectionPanelProps {
  onClose: () => void;
  hasPointCloud: boolean;
  totalInBand: number;
  renderedCount: number;
}

export function ScanSectionPanel({
  onClose,
  hasPointCloud,
  totalInBand,
  renderedCount,
}: ScanSectionPanelProps): React.ReactElement {
  const displayOptions = useViewerStore((s) => s.drawing2DDisplayOptions);
  const updateDisplayOptions = useViewerStore((s) => s.updateDrawing2DDisplayOptions);

  const { showScanSection, scanSectionThickness, scanSectionOpacity, scanSectionIncludeInExport } = displayOptions;

  return (
    <div className="flex flex-col h-full bg-background border-l">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
        <div className="flex items-center gap-2">
          <ScanLine className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-sm">Scan Layer</h2>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-xs font-medium">Show scan points</span>
          <input
            type="checkbox"
            checked={showScanSection}
            onChange={(e) => updateDisplayOptions({ showScanSection: e.target.checked })}
            className="accent-teal-600"
          />
        </label>

        {!hasPointCloud && (
          <p className="text-xs text-muted-foreground px-0.5">
            No point cloud is loaded. Load a .laz/.las/.e57/.ply/.pcd scan and
            this layer will show the points within a thin band around the
            section plane.
          </p>
        )}

        <div className="flex flex-col gap-1">
          <Label className="text-[10px] text-muted-foreground">
            Band thickness: {scanSectionThickness >= 1
              ? `${scanSectionThickness.toFixed(2)} m`
              : `${Math.round(scanSectionThickness * 1000)} mm`}
          </Label>
          <input
            type="range"
            min={SCAN_SECTION_THICKNESS_MIN}
            max={SCAN_SECTION_THICKNESS_MAX}
            step={0.01}
            value={scanSectionThickness}
            onChange={(e) => updateDisplayOptions({ scanSectionThickness: Number(e.target.value) })}
            className="h-1 accent-teal-600 cursor-pointer"
            title="Points within ± half this thickness of the section plane are shown"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-[10px] text-muted-foreground">
            Dot opacity: {Math.round(scanSectionOpacity * 100)}%
          </Label>
          <input
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
          <span className="text-xs">Include in SVG export</span>
          <input
            type="checkbox"
            checked={scanSectionIncludeInExport}
            onChange={(e) => updateDisplayOptions({ scanSectionIncludeInExport: e.target.checked })}
            className="accent-teal-600"
          />
        </label>

        {hasPointCloud && (
          <p className="text-[11px] text-muted-foreground border-t pt-2">
            {!showScanSection
              ? 'A scan is loaded but the overlay is hidden — enable "Show scan points" above.'
              : renderedCount >= totalInBand
                ? `Showing all ${totalInBand.toLocaleString()} points in band.`
                : `Showing ${renderedCount.toLocaleString()} of ${totalInBand.toLocaleString()} points in band (decimated for display).`}
          </p>
        )}
      </div>
    </div>
  );
}

export default ScanSectionPanel;
