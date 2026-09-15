/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Camera, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';

interface BCFViewpointCaptureButtonsProps {
  onCapture3D: () => void;
  onCapture2D: () => void;
  canCapture2D: boolean;
}

/** The two canonical snapshot sources available to a BCF topic. */
export function BCFViewpointCaptureButtons({
  onCapture3D,
  onCapture2D,
  canCapture2D,
}: BCFViewpointCaptureButtonsProps): React.ReactElement {
  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="sm" onClick={onCapture3D} {...tourAnchor(TOUR_ANCHORS.bcfCaptureViewpoint)}>
        <Camera className="h-3 w-3 mr-1" />
        Capture 3D
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onCapture2D}
        disabled={!canCapture2D}
        aria-label="Capture current 2D section as viewpoint"
        title={canCapture2D ? 'Attach the visible annotated 2D section' : 'Open a supported, fully rendered 2D section first'}
      >
        <ScanLine className="h-3 w-3 mr-1" />
        Capture 2D
      </Button>
    </div>
  );
}
