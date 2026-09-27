/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A real dialog for the scaled PDF export (#5496), replacing the
 * `window.prompt` flow (issue #2042's stopgap: "a real scale dialog is
 * #5496"). Offers the same inputs the prompt did — every `COMMON_SCALES`
 * preset, "as displayed", or a custom denominator — plus the paper the PDF
 * will use, and calls the SAME `handleExportPDF(scaleFactor?)` the prompt
 * called, unchanged. That is what keeps exported bytes identical to before:
 * this dialog only replaces how the number reaches that function, never what
 * happens once it does.
 *
 * Sheet mode's scale and paper are not choices here — `handleExportPDF`
 * already reads them off the active sheet (`activeSheet.scale`,
 * `activeSheet.paper`) and ignores any `scaleFactor` argument in that branch
 * (see `useDrawingExport.ts`) — so the dialog states them read-only rather
 * than offering controls that would do nothing.
 */

import { useId, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { COMMON_SCALES, type DrawingSheet } from '@ifc-lite/drawing-2d';
import { useTranslation } from '@/i18n';
import { DRAWING_OMISSION_LABEL_KEYS, type DrawingExportOmission } from '@/lib/export/drawing-export-omissions';

const AS_DISPLAYED = 'as-displayed';
const CUSTOM = 'custom';

export interface DrawingPdfExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The drawing's current on-screen scale (the "N" in "1:N"), offered as "As displayed". */
  displayedScale: number;
  sheetEnabled: boolean;
  activeSheet: DrawingSheet | null;
  /** Content the selected PDF writer will leave out. */
  omissions?: readonly DrawingExportOmission[];
  /** `useDrawingExport`'s `handleExportPDF`, called exactly as the old prompt called it. */
  onExport: (scaleFactor?: number) => void;
}

export function DrawingPdfExportDialog({
  open, onOpenChange, displayedScale, sheetEnabled, activeSheet, omissions = [], onExport,
}: DrawingPdfExportDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<string>(AS_DISPLAYED);
  const [customScale, setCustomScale] = useState('100');
  const [error, setError] = useState<string | null>(null);
  const scaleSelectId = useId();
  const customInputId = useId();

  const usesSheetScale = sheetEnabled && activeSheet !== null;

  const handleOpenChange = (next: boolean) => {
    if (next) { setMode(AS_DISPLAYED); setCustomScale('100'); setError(null); }
    onOpenChange(next);
  };

  const handleExport = () => {
    // Sheet mode: the Select above isn't rendered (see the JSX below), so
    // `mode` can only be its AS_DISPLAYED default here, and `handleExportPDF`
    // itself ignores any `scaleFactor` argument once `activeSheet` is set
    // (useDrawingExport.ts) — reading the sheet's own scale/paper instead. No
    // separate branch is needed: the AS_DISPLAYED case below already calls
    // `onExport(undefined)`, which is exactly what that path wants.
    if (mode === AS_DISPLAYED) {
      onExport(undefined);
      onOpenChange(false);
      return;
    }
    if (mode === CUSTOM) {
      const n = Number(customScale.trim().replace(/^1:/, ''));
      if (!Number.isFinite(n) || n <= 0) {
        setError(t('section2d.pdf.invalid', { input: customScale }));
        return;
      }
      onExport(n);
      onOpenChange(false);
      return;
    }
    const preset = COMMON_SCALES.find((s) => s.name === mode);
    onExport(preset?.factor);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('section2d.pdf.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('section2d.pdf.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={scaleSelectId}>{t('section2d.pdf.scaleLabel')}</Label>
            {usesSheetScale ? (
              <p className="text-sm text-muted-foreground">
                {t('section2d.pdf.sheetScaleLocked', { scale: activeSheet.scale.name })}
              </p>
            ) : (
              <>
                <Select value={mode} onValueChange={(v) => { setMode(v); setError(null); }}>
                  <SelectTrigger id={scaleSelectId} className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AS_DISPLAYED}>
                      {t('section2d.pdf.asDisplayed', { scale: displayedScale })}
                    </SelectItem>
                    {COMMON_SCALES.map((s) => (
                      <SelectItem key={s.name} value={s.name}>{s.name} — {s.useCase}</SelectItem>
                    ))}
                    <SelectItem value={CUSTOM}>{t('section2d.pdf.customScale')}</SelectItem>
                  </SelectContent>
                </Select>
                {mode === CUSTOM && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-sm text-muted-foreground">1:</span>
                    <Input
                      id={customInputId}
                      className="h-8 w-28 text-sm"
                      inputMode="decimal"
                      value={customScale}
                      onChange={(e) => { setCustomScale(e.target.value); setError(null); }}
                      aria-invalid={error !== null}
                    />
                  </div>
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{t('section2d.pdf.paperLabel')}</Label>
            <p className="text-sm text-muted-foreground">
              {usesSheetScale
                ? t('section2d.pdf.paperSheet', {
                  name: activeSheet.paper.name,
                  width: Math.round(activeSheet.paper.widthMm),
                  height: Math.round(activeSheet.paper.heightMm),
                })
                : t('section2d.pdf.paperAuto')}
            </p>
          </div>
          {omissions.length > 0 && (
            <div role="note" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">{t('section2d.export.omission.pdfTitle')}</p>
              <ul className="mt-1 list-disc pl-5">
                {omissions.map((omission) => (
                  <li key={omission}>{t(DRAWING_OMISSION_LABEL_KEYS[omission])}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('section2d.pdf.cancel')}</Button>
          <Button onClick={handleExport}>{t('section2d.pdf.export')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
