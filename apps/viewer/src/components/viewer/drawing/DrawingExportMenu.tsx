/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Drawing header's one Export menu (#5494): SVG, DXF, PDF, Print, and
 *  saving the markup into the model. File exports need a drawing. The PDF
 *  item opens a real scale/paper dialog (#5496) instead of exporting at the
 *  on-screen scale directly — everything else in the menu stays one click. */

import { useState } from 'react';
import { ChevronDown, Download, FileDown, FileText, Printer } from 'lucide-react';
import type { DrawingSheet } from '@ifc-lite/drawing-2d';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { drawingExportOmissions, DRAWING_OMISSION_LABEL_KEYS, type DrawingExportContent } from '@/lib/export/drawing-export-omissions';
import { SaveMarkupToModelMenuItem } from '../SaveMarkupToModelButton';
import { DrawingPdfExportDialog } from './DrawingPdfExportDialog';

export interface DrawingExportMenuProps {
  hasDrawing: boolean;
  /** Icon-only trigger for narrow hosts. */
  compact: boolean;
  onExportSvg: () => void;
  onExportDxf: () => void;
  /** `useDrawingExport`'s `handleExportPDF`; the dialog supplies the scale. */
  onExportPdf: (scaleFactor?: number) => void;
  onPrint: () => void;
  /** The drawing's current on-screen scale, offered as the PDF dialog's "As displayed". */
  displayedScale: number;
  sheetEnabled: boolean;
  activeSheet: DrawingSheet | null;
  markupCounts: DrawingExportContent['markupCounts'];
  visibleUnderlayCount: number;
}

export function DrawingExportMenu({
  hasDrawing, compact, onExportSvg, onExportDxf, onExportPdf, onPrint,
  displayedScale, sheetEnabled, activeSheet, markupCounts, visibleUnderlayCount,
}: DrawingExportMenuProps) {
  const { t } = useTranslation();
  const label = t('section2d.export.menu');
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false);
  const content: DrawingExportContent = {
    markupCounts,
    visibleUnderlayCount,
    sheetScale: sheetEnabled && activeSheet ? activeSheet.scale.factor : null,
  };
  const pdfOmissions = drawingExportOmissions(content, 'pdf');

  const handleDxfExport = async () => {
    const omissions = drawingExportOmissions(content, 'dxf');
    if (omissions.length > 0) {
      const confirmed = await confirmDialog({
        title: t('section2d.export.omission.dxfTitle'),
        description: t('section2d.export.omission.dxfDescription', {
          items: omissions.map((omission) => t(DRAWING_OMISSION_LABEL_KEYS[omission])).join(', '),
        }),
        confirmLabel: t('section2d.export.omission.continue'),
      });
      if (!confirmed) return;
    }
    onExportDxf();
  };
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              {compact ? (
                <Button variant="ghost" size="icon-sm" aria-label={label}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" aria-label={label}>
                  <Download className="h-3.5 w-3.5" />
                  {label}
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              )}
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={onExportSvg} disabled={!hasDrawing}>
            <Download className="mr-2 h-4 w-4" />{t('section2d.export.svg')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { void handleDxfExport(); }} disabled={!hasDrawing}>
            <FileDown className="mr-2 h-4 w-4" />{t('section2d.export.dxf')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPdfDialogOpen(true)} disabled={!hasDrawing}>
            <FileText className="mr-2 h-4 w-4" />{t('section2d.export.pdf')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPrint} disabled={!hasDrawing}>
            <Printer className="mr-2 h-4 w-4" />{t('section2d.export.print')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <SaveMarkupToModelMenuItem />
        </DropdownMenuContent>
      </DropdownMenu>
      <DrawingPdfExportDialog
        open={pdfDialogOpen} onOpenChange={setPdfDialogOpen}
        displayedScale={displayedScale} sheetEnabled={sheetEnabled} activeSheet={activeSheet}
        omissions={pdfOmissions}
        onExport={onExportPdf}
      />
    </>
  );
}
