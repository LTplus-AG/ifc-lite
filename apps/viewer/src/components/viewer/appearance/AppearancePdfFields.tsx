/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { appearanceSelectClass } from './AppearanceSourceFields.js';
import { AppearancePdfCrop } from './AppearancePdfCrop.js';
import type { AppearancePdfControls, AppearancePdfPasswordPrompt } from './pdf-controls.js';

export function AppearancePdfFields({ pdf, disabled, onInvalid }: {
  pdf: AppearancePdfControls; disabled: boolean; onInvalid(name: string, invalid: boolean): void;
}) {
  const [pageText, setPageText] = useState(String(pdf.pageNumber));
  const pageValid = pageText.trim() !== '' && Number.isInteger(Number(pageText)) && Number(pageText) >= 1 && Number(pageText) <= pdf.pageCount;
  useEffect(() => { setPageText(String(pdf.pageNumber)); onInvalid('pdfPage', false); }, [pdf.pageNumber, onInvalid]);
  useEffect(() => () => onInvalid('pdfPage', false), [onInvalid]);
  const cropInvalid = useCallback((name: string, invalid: boolean) => onInvalid(`pdfCrop${name}`, invalid), [onInvalid]);
  const commitPage = () => { if (pageValid && Number(pageText) !== pdf.pageNumber) pdf.onPageChange(Number(pageText)); };
  const pageReady = pdf.pageSizePoints.every(value => Number.isFinite(value) && value > 0);
  return <section className="space-y-3 rounded-lg border p-3" aria-label="PDF page settings" aria-busy={!!pdf.busy}>
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-medium">PDF page</h3>
      {pdf.busy && <span role="status" className="flex items-center gap-1 text-[10px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Updating page…</span>}
    </div>
    <p className="truncate text-[11px] text-muted-foreground" title={pdf.documentName}>{pdf.documentName}</p>
    <fieldset disabled={disabled} className="space-y-3">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="icon-sm" aria-label="Previous PDF page" disabled={disabled || pdf.pageNumber <= 1}
          onClick={() => pdf.onPageChange(pdf.pageNumber - 1)}><ChevronLeft aria-hidden="true" /></Button>
        <label className="flex min-w-0 flex-1 items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <span>Page</span><Input aria-label="PDF page number" type="number" min="1" max={pdf.pageCount} step="1" value={pageText}
            aria-invalid={!pageValid} className="h-8 min-w-0 max-w-20 text-center text-xs aria-[invalid=true]:border-destructive"
            onChange={event => {
              const next = event.currentTarget.value; const number = Number(next);
              setPageText(next); onInvalid('pdfPage', next.trim() === '' || !Number.isInteger(number) || number < 1 || number > pdf.pageCount);
            }} onBlur={commitPage} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } }} />
          <span className="whitespace-nowrap">of {pdf.pageCount.toLocaleString()}</span>
        </label>
        <Button type="button" variant="outline" size="icon-sm" aria-label="Next PDF page" disabled={disabled || pdf.pageNumber >= pdf.pageCount}
          onClick={() => pdf.onPageChange(pdf.pageNumber + 1)}><ChevronRight aria-hidden="true" /></Button>
      </div>
      {!pageValid && <p role="alert" className="text-[10px] text-destructive">Choose a page from 1 to {pdf.pageCount}.</p>}
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[11px] text-muted-foreground"><span>Page rotation</span>
          <select aria-label="PDF page rotation" className={appearanceSelectClass} value={pdf.rotation} onChange={event => {
            const rotation = Number(event.target.value);
            if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) pdf.onRotationChange(rotation);
          }}><option value="0">Original</option><option value="90">90° clockwise</option><option value="180">180°</option><option value="270">90° counterclockwise</option></select>
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground"><span>Image quality</span>
          <select aria-label="PDF image quality" className={appearanceSelectClass} value={pdf.requestedDpi} onChange={event => pdf.onDpiChange(Number(event.target.value))}>
            <option value="72">Draft · 72 dpi</option><option value="144">Standard · 144 dpi</option><option value="216">Fine · 216 dpi</option><option value="300">High · 300 dpi</option>
            {![72, 144, 216, 300].includes(pdf.requestedDpi) && <option value={pdf.requestedDpi}>{pdf.requestedDpi} dpi</option>}
          </select>
        </label>
      </div>
    </fieldset>
    {pdf.effectiveDpi !== undefined && pdf.effectiveDpi < pdf.requestedDpi && <p className="text-[10px] leading-relaxed text-muted-foreground">
      Rendered at {Math.round(pdf.effectiveDpi)} dpi to fit image limits. Paper size is unchanged.
    </p>}
    {pageReady && <AppearancePdfCrop pdf={pdf} disabled={disabled || !!pdf.busy} onInvalid={cropInvalid} />}
    {pdf.error && <p role="alert" className="text-[11px] leading-relaxed text-destructive">{pdf.error}</p>}
  </section>;
}

export function AppearancePdfPassword({ prompt, disabled }: { prompt: AppearancePdfPasswordPrompt; disabled: boolean }) {
  const [password, setPassword] = useState('');
  return <form aria-label="Unlock PDF" className="space-y-2 rounded-lg border p-3" onSubmit={event => {
    event.preventDefault();
    if (!disabled && !prompt.busy && password.length > 0) { prompt.onSubmit(password); setPassword(''); }
  }}>
    <p className="text-xs font-medium">Unlock PDF</p>
    <p className="break-words text-[11px] text-muted-foreground">{prompt.documentName} needs a password.</p>
    {prompt.incorrect && <p role="alert" className="text-[11px] text-destructive">That password did not unlock the PDF. Try again.</p>}
    <label className="block space-y-1 text-[11px] text-muted-foreground"><span>PDF password</span>
      <Input type="password" aria-label="PDF password" autoComplete="off" value={password} disabled={disabled || prompt.busy}
        className="h-8 text-xs" onChange={event => setPassword(event.currentTarget.value)} />
    </label>
    <div className="flex justify-end gap-2">
      {prompt.onCancel && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={prompt.onCancel}>Cancel</Button>}
      <Button type="submit" size="sm" disabled={disabled || prompt.busy || !password.length}>{prompt.busy ? 'Unlocking…' : 'Unlock PDF'}</Button>
    </div>
  </form>;
}
