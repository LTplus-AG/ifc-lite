/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the sheet will be, and the two ways it can be wrong: the page readout,
 * the oversize block, and the perspective-camera notice for the 3D-view PDF
 * dialog (#2042).
 *
 * Split out of `PdfViewExportDialog` when the appearance controls landed, so
 * the dialog stays a composition of named sections rather than one long body.
 * Every string here is a NUMBER the user is expected to act on, which is why
 * none of them is a generic "check your settings": an unprintable page names
 * the limit it broke, and the perspective notice offers the camera switch
 * rather than silently changing the user's view.
 */

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { MAX_PDF_PAGE_DIMENSION_MM } from '@/lib/export/view-pdf/view-pdf-scale';

export interface PdfViewPageNoticesProps {
  /** The estimated sheet, or `null` while it cannot be computed. */
  preview: { page: { widthMm: number; heightMm: number }; paper: { name: string } | null } | null;
  oversize: boolean;
  /** `null` when no camera has been read yet. */
  projectionMode: 'orthographic' | 'perspective' | null;
  onSwitchToOrthographic: () => void;
  /** Millimetre formatter, shared with the dialog so both round identically. */
  formatMm: (value: number) => string;
}

export function PdfViewPageNotices({
  preview,
  oversize,
  projectionMode,
  onSwitchToOrthographic,
  formatMm,
}: PdfViewPageNoticesProps) {
  return (
    <>
      {/* The sheet size changes as the scale changes, with focus staying in
          the Select. Without a live region a screen-reader user picks a
          scale and is told nothing about the page it produces, which is
          the single number this dialog exists to report. */}
      <p
        className="text-xs text-muted-foreground"
        data-testid="pdf-view-page-readout"
        aria-live="polite"
      >
        {preview
          ? `Estimated page: ${formatMm(preview.page.widthMm)} x ${formatMm(preview.page.heightMm)} mm` +
            (preview.paper ? ` (fits ${preview.paper.name})` : ' (larger than any ISO sheet)') +
            '. The exported page is sized to the drawing itself and will never be larger.'
          : 'Page size is not available yet. Load a model and choose a valid scale.'}
      </p>

      {oversize && preview && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Page too large to print</AlertTitle>
          <AlertDescription>
            {`This scale needs a page of ${formatMm(preview.page.widthMm)} x ` +
              `${formatMm(preview.page.heightMm)} mm. A PDF page cannot exceed ` +
              `${MAX_PDF_PAGE_DIMENSION_MM} mm on a side. Choose a smaller scale.`}
          </AlertDescription>
        </Alert>
      )}

      {projectionMode === 'perspective' ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Perspective camera</AlertTitle>
          <AlertDescription>
            <span>
              The PDF is an orthographic (parallel) projection along your current view
              direction, so near and far objects print at the same scale. That is the only
              way a printed drawing can carry a single scale. Switch to orthographic to
              see the same parallel projection on screen.
            </span>
            <Button variant="outline" size="sm" className="mt-2" onClick={onSwitchToOrthographic}>
              Switch camera to orthographic
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">
          Orthographic camera, so the printed scale is exact. The sheet covers
          everything currently visible, not only the part framed on screen:
          panning and zooming change what you look at, not what is printed.
        </p>
      )}
    </>
  );
}
