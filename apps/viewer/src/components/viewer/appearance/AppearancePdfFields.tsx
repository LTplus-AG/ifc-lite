/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { appearanceSelectClass } from './AppearanceSourceFields.js';
import { AppearancePdfCrop } from './AppearancePdfCrop.js';
import type { AppearancePdfControls, AppearancePdfPasswordPrompt } from './pdf-controls.js';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export function AppearancePdfFields({ pdf, disabled, onInvalid }: {
  pdf: AppearancePdfControls; disabled: boolean; onInvalid(name: string, invalid: boolean): void;
}) {
  const { t, locale } = useTranslation();
  const [pageText, setPageText] = useState(String(pdf.pageNumber));
  const pageValid = pageText.trim() !== '' && Number.isInteger(Number(pageText)) && Number(pageText) >= 1 && Number(pageText) <= pdf.pageCount;
  useEffect(() => { setPageText(String(pdf.pageNumber)); onInvalid('pdfPage', false); }, [pdf.pageNumber, onInvalid]);
  useEffect(() => () => onInvalid('pdfPage', false), [onInvalid]);
  const cropInvalid = useCallback((name: string, invalid: boolean) => onInvalid(`pdfCrop${name}`, invalid), [onInvalid]);
  const commitPage = () => { if (pageValid && Number(pageText) !== pdf.pageNumber) pdf.onPageChange(Number(pageText)); };
  const pageReady = pdf.pageSizePoints.every(value => Number.isFinite(value) && value > 0);
  return <section className="space-y-3 rounded-lg border p-3" aria-label={t('appearance.pdfFields.pageSettingsAriaLabel')} aria-busy={!!pdf.busy}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-medium">{t('appearance.pdfFields.heading')}</h3>
      {pdf.busy && <output className="flex items-center gap-1 text-2xs text-muted-foreground"><Spinner size="xs" />{t('appearance.pdfFields.updatingPage')}</output>}
    </div>
    <p className="truncate text-2xs text-muted-foreground" title={pdf.documentName}>{pdf.documentName}</p>
    <fieldset disabled={disabled} className="space-y-3">
      <div className="flex items-center gap-2">
        <IconButton
          label={t('appearance.pdfFields.previousPageAriaLabel')}
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={disabled || pdf.pageNumber <= 1}
          onClick={() => pdf.onPageChange(pdf.pageNumber - 1)}
        ><ChevronLeft aria-hidden="true" /></IconButton>
        <label className="flex min-w-0 flex-1 items-center justify-center gap-2 text-2xs text-muted-foreground">
          <span>{t('appearance.pdfFields.pageLabel')}</span><Input aria-label={t('appearance.pdfFields.pageNumberAriaLabel')} type="number" min="1" max={pdf.pageCount} step="1" value={pageText}
            aria-invalid={!pageValid} className="h-8 min-w-0 max-w-20 text-center text-xs aria-[invalid=true]:border-destructive"
            onChange={event => {
              const next = event.currentTarget.value; const number = Number(next);
              setPageText(next); onInvalid('pdfPage', next.trim() === '' || !Number.isInteger(number) || number < 1 || number > pdf.pageCount);
            }} onBlur={commitPage} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } }} />
          <span className="whitespace-nowrap">{t('appearance.pdfFields.ofPageCount', { count: formatLocaleNumber(locale, pdf.pageCount) })}</span>
        </label>
        <IconButton
          label={t('appearance.pdfFields.nextPageAriaLabel')}
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={disabled || pdf.pageNumber >= pdf.pageCount}
          onClick={() => pdf.onPageChange(pdf.pageNumber + 1)}
        ><ChevronRight aria-hidden="true" /></IconButton>
      </div>
      {!pageValid && <p role="alert" className="text-2xs text-destructive">{t('appearance.pdfFields.pageRangeError', { count: pdf.pageCount })}</p>}
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-2xs text-muted-foreground"><span>{t('appearance.pdfFields.rotationLabel')}</span>
          <select aria-label={t('appearance.pdfFields.rotationAriaLabel')} className={appearanceSelectClass} value={pdf.rotation} onChange={event => {
            const rotation = Number(event.target.value);
            if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) pdf.onRotationChange(rotation);
          }}><option value="0">{t('appearance.pdfFields.rotationOriginal')}</option><option value="90">{t('appearance.pdfFields.rotation90')}</option><option value="180">{t('appearance.pdfFields.rotation180')}</option><option value="270">{t('appearance.pdfFields.rotation270')}</option></select>
        </label>
        <label className="space-y-1 text-2xs text-muted-foreground"><span>{t('appearance.pdfFields.qualityLabel')}</span>
          <select aria-label={t('appearance.pdfFields.qualityAriaLabel')} className={appearanceSelectClass} value={pdf.requestedDpi} onChange={event => pdf.onDpiChange(Number(event.target.value))}>
            <option value="72">{t('appearance.pdfFields.qualityDraft')}</option><option value="144">{t('appearance.pdfFields.qualityStandard')}</option><option value="216">{t('appearance.pdfFields.qualityFine')}</option><option value="300">{t('appearance.pdfFields.qualityHigh')}</option>
            {![72, 144, 216, 300].includes(pdf.requestedDpi) && <option value={pdf.requestedDpi}>{t('appearance.pdfFields.qualityCustomDpi', { dpi: pdf.requestedDpi })}</option>}
          </select>
        </label>
      </div>
    </fieldset>
    {pdf.effectiveDpi !== undefined && pdf.effectiveDpi < pdf.requestedDpi && <p className="text-2xs leading-relaxed text-muted-foreground">
      {t('appearance.pdfFields.effectiveDpiNote', { dpi: Math.round(pdf.effectiveDpi) })}
    </p>}
    {pageReady && <AppearancePdfCrop pdf={pdf} disabled={disabled || !!pdf.busy} onInvalid={cropInvalid} />}
    {pdf.error && <p role="alert" className="text-2xs leading-relaxed text-destructive">{pdf.error}</p>}
  </section>;
}

export function AppearancePdfPassword({ prompt, disabled }: { prompt: AppearancePdfPasswordPrompt; disabled: boolean }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  return <form aria-label={t('appearance.pdfFields.unlockPdfAriaLabel')} className="space-y-2 rounded-lg border p-3" onSubmit={event => {
    event.preventDefault();
    if (!disabled && !prompt.busy && password.length > 0) { prompt.onSubmit(password); setPassword(''); }
  }}>
    <p className="text-xs font-medium">{t('appearance.pdfFields.unlockPdfHeading')}</p>
    <p className="break-words text-2xs text-muted-foreground">{t('appearance.pdfFields.needsPassword', { documentName: prompt.documentName })}</p>
    {prompt.incorrect && <p role="alert" className="text-2xs text-destructive">{t('appearance.pdfFields.incorrectPassword')}</p>}
    <label className="block space-y-1 text-2xs text-muted-foreground"><span>{t('appearance.pdfFields.passwordLabel')}</span>
      <Input type="password" aria-label={t('appearance.pdfFields.passwordAriaLabel')} autoComplete="off" value={password} disabled={disabled || prompt.busy}
        className="h-8 text-xs" onChange={event => setPassword(event.currentTarget.value)} />
    </label>
    <div className="flex justify-end gap-2">
      {prompt.onCancel && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={prompt.onCancel}>{t('appearance.pdfFields.cancel')}</Button>}
      <Button type="submit" size="sm" disabled={disabled || prompt.busy || !password.length}>{prompt.busy ? t('appearance.pdfFields.unlocking') : t('appearance.pdfFields.unlockPdfHeading')}</Button>
    </div>
  </form>;
}
