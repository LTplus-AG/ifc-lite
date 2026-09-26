/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PdfRect } from '@/lib/appearance/pdf/types.js';
import { capturePointer, releasePointer } from '@/lib/pointer-capture';
import type { AppearancePdfControls } from './pdf-controls.js';
import { useTranslation, type TranslationKey } from '@/i18n';

const mmPerPoint = 25.4 / 72;
const displayMm = (points: number) => String(Math.round(points * mmPerPoint * 1000) / 1000);

function Margin({ name, labelKey, ariaLabelKey, value, maximum, onChange, onInvalid }: {
  name: string; labelKey: TranslationKey; ariaLabelKey: TranslationKey; value: number; maximum: number; onChange(value: number): void;
  onInvalid(name: string, invalid: boolean): void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(displayMm(value));
  const invalid = text.trim() === '' || !Number.isFinite(Number(text)) || Number(text) < 0 || Number(text) >= maximum * mmPerPoint;
  useEffect(() => { setText(displayMm(value)); onInvalid(name, false); }, [value, name, onInvalid]);
  useEffect(() => () => onInvalid(name, false), [name, onInvalid]);
  return <label className="block space-y-1 text-xs text-muted-foreground"><span>{t(labelKey)}</span>
    <Input aria-label={t(ariaLabelKey)} type="number" min="0" step="any"
      value={text} aria-invalid={invalid} className="h-8 text-xs aria-[invalid=true]:border-destructive" onChange={event => {
        const next = event.currentTarget.value;
        const points = Number(next) / mmPerPoint;
        const bad = next.trim() === '' || !Number.isFinite(points) || points < 0 || points >= maximum;
        setText(next); onInvalid(name, bad);
        if (!bad) onChange(points);
      }} />
  </label>;
}

export function AppearancePdfCrop({ pdf, disabled, onInvalid }: {
  pdf: AppearancePdfControls; disabled: boolean; onInvalid(name: string, invalid: boolean): void;
}) {
  const { t } = useTranslation();
  const [reset, setReset] = useState(0);
  const [drag, setDrag] = useState<{ id: number; start: [number, number]; end: [number, number] } | null>(null);
  const [width, height] = pdf.pageSizePoints;
  const [left, top, cropWidth, cropHeight] = pdf.cropPoints;
  const right = width - left - cropWidth;
  const bottom = height - top - cropHeight;
  const point = (event: PointerEvent<HTMLDivElement>): [number, number] => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))];
  };
  const rectangle = (a: [number, number], b: [number, number]): PdfRect =>
    [Math.min(a[0], b[0]) * width, Math.min(a[1], b[1]) * height, Math.abs(a[0] - b[0]) * width, Math.abs(a[1] - b[1]) * height];
  const shown = drag ? rectangle(drag.start, drag.end) : pdf.cropPoints;
  return <div className="space-y-2">
    {pdf.pagePreviewUrl && <div className="rounded-md border bg-muted/40 p-2">
      {/* The focusable drawing surface uses pointer capture and Escape to cancel an active crop. */}
      {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
      <div role="group" aria-label={t('appearance.pdfCrop.previewAriaLabel')} tabIndex={0}
        className={`relative mx-auto w-full overflow-hidden bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring ${disabled ? 'opacity-60' : 'cursor-crosshair'}`}
        style={{ aspectRatio: `${width}/${height}`, maxWidth: 240 * width / height, touchAction: disabled ? 'auto' : 'none' }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setDrag(null); } }}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          const start = point(event); if (!start.every(Number.isFinite)) return;
          event.preventDefault(); event.currentTarget.focus();
          capturePointer(event.currentTarget, event.pointerId);
          setDrag({ id: event.pointerId, start, end: start });
        }}
        onPointerMove={event => { if (drag?.id === event.pointerId) setDrag({ ...drag, end: point(event) }); }}
        onPointerCancel={() => setDrag(null)}
        onPointerUp={event => {
          if (!drag || drag.id !== event.pointerId) return;
          const end = point(event); const bounds = event.currentTarget.getBoundingClientRect();
          if (!disabled && Math.abs(end[0] - drag.start[0]) * bounds.width >= 3 && Math.abs(end[1] - drag.start[1]) * bounds.height >= 3) {
            pdf.onCropChange(rectangle(drag.start, end));
          }
          releasePointer(event.currentTarget, event.pointerId);
          setDrag(null);
        }}>
        <img src={pdf.pagePreviewUrl} alt={t('appearance.pdfCrop.pageAlt', { pageNumber: pdf.pageNumber, documentName: pdf.documentName })} draggable={false} className="pointer-events-none block h-full w-full select-none" />
        <div aria-hidden="true" className="pointer-events-none absolute border-2 border-primary bg-primary/5"
          style={{ left: `${shown[0] / width * 100}%`, top: `${shown[1] / height * 100}%`, width: `${shown[2] / width * 100}%`, height: `${shown[3] / height * 100}%`, boxShadow: '0 0 0 999px rgb(0 0 0 / 35%)' }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('appearance.pdfCrop.dragToCrop')}</p>
    </div>}
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium">{t('appearance.pdfCrop.pageCropLabel')}</span>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled}
        onClick={() => { setReset(value => value + 1); pdf.onCropChange([0, 0, width, height]); }}>{t('appearance.pdfCrop.useFullPage')}</Button>
    </div>
    <fieldset disabled={disabled} className="grid grid-cols-2 gap-2" aria-label={t('appearance.pdfCrop.marginsAriaLabel')}>
      <Margin key={`${reset}:Left`} name="Left" labelKey="appearance.pdfCrop.marginLeftMm" ariaLabelKey="appearance.pdfCrop.marginLeftAriaLabel" value={left} maximum={width - right} onInvalid={onInvalid} onChange={value => pdf.onCropChange([value, top, width - value - right, cropHeight])} />
      <Margin key={`${reset}:Top`} name="Top" labelKey="appearance.pdfCrop.marginTopMm" ariaLabelKey="appearance.pdfCrop.marginTopAriaLabel" value={top} maximum={height - bottom} onInvalid={onInvalid} onChange={value => pdf.onCropChange([left, value, cropWidth, height - value - bottom])} />
      <Margin key={`${reset}:Right`} name="Right" labelKey="appearance.pdfCrop.marginRightMm" ariaLabelKey="appearance.pdfCrop.marginRightAriaLabel" value={right} maximum={width - left} onInvalid={onInvalid} onChange={value => pdf.onCropChange([left, top, width - left - value, cropHeight])} />
      <Margin key={`${reset}:Bottom`} name="Bottom" labelKey="appearance.pdfCrop.marginBottomMm" ariaLabelKey="appearance.pdfCrop.marginBottomAriaLabel" value={bottom} maximum={height - top} onInvalid={onInvalid} onChange={value => pdf.onCropChange([left, top, cropWidth, height - top - value])} />
    </fieldset>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('appearance.pdfCrop.marginsNote')}</p>
  </div>;
}
