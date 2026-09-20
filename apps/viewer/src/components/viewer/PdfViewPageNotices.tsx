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
import { useTranslation } from '@/i18n';
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
  const { t } = useTranslation();
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
          ? t(preview.paper ? 'sheetsPdf.pdfView.pageReadoutFits' : 'sheetsPdf.pdfView.pageReadoutOversizeIso', {
              width: formatMm(preview.page.widthMm),
              height: formatMm(preview.page.heightMm),
              paperName: preview.paper?.name ?? '',
            })
          : t('sheetsPdf.pdfView.pageReadoutUnavailable')}
      </p>

      {oversize && preview && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('sheetsPdf.pdfView.oversizeTitle')}</AlertTitle>
          <AlertDescription>
            {t('sheetsPdf.pdfView.oversizeDescription', {
              width: formatMm(preview.page.widthMm),
              height: formatMm(preview.page.heightMm),
              maxDimension: MAX_PDF_PAGE_DIMENSION_MM,
            })}
          </AlertDescription>
        </Alert>
      )}

      {projectionMode === null ? (
        // No camera at all (nothing loaded, or no WebGPU). Falling through to
        // the orthographic branch here would state "the printed scale is
        // exact" about a sheet that cannot be produced, which is the one claim
        // this dialog must never make loosely. Export is already disabled in
        // this state, so the honest thing is to say nothing about projection.
        null
      ) : projectionMode === 'perspective' ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('sheetsPdf.pdfView.perspectiveTitle')}</AlertTitle>
          <AlertDescription>
            <span>{t('sheetsPdf.pdfView.perspectiveDescription')}</span>
            <Button variant="outline" size="sm" className="mt-2" onClick={onSwitchToOrthographic}>
              {t('sheetsPdf.pdfView.switchToOrthographicButton')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">{t('sheetsPdf.pdfView.orthographicNote')}</p>
      )}
    </>
  );
}
