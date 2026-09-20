/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId } from 'react';
import { Camera, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { useTranslation } from '@/i18n';

interface BCFViewpointCaptureButtonsProps {
  onCapture3D: () => void;
  onCapture2D: () => void;
  /** Why Capture 2D is unavailable, or null when it can run. */
  capture2DBlockReason: string | null;
}

/** The two canonical snapshot sources available to a BCF topic. */
export function BCFViewpointCaptureButtons({
  onCapture3D,
  onCapture2D,
  capture2DBlockReason,
}: BCFViewpointCaptureButtonsProps): React.ReactElement {
  const { t } = useTranslation();
  const blocked = capture2DBlockReason !== null;
  const reasonId = useId();
  return (
    <div className="space-y-1">
      {/* flex-wrap: the row must never clip a button at a narrow sidebar width (#4802). */}
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="outline" size="sm" onClick={onCapture3D} {...tourAnchor(TOUR_ANCHORS.bcfCaptureViewpoint)}>
          <Camera className="h-3 w-3 mr-1" />
          {t('bcf.viewpointCapture.capture3d')}
        </Button>
        {/* A disabled Button has pointer-events-none, so the hover title lives on the wrapper. */}
        <span className="inline-flex" title={capture2DBlockReason ?? t('bcf.viewpointCapture.capture2dDefaultTitle')}>
          <Button
            variant="outline"
            size="sm"
            onClick={onCapture2D}
            disabled={blocked}
            aria-label={t('bcf.viewpointCapture.capture2dAria')}
            aria-describedby={blocked ? reasonId : undefined}
          >
            <ScanLine className="h-3 w-3 mr-1" />
            {t('bcf.viewpointCapture.capture2d')}
          </Button>
        </span>
      </div>
      {blocked && (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {capture2DBlockReason}
        </p>
      )}
    </div>
  );
}
