/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PdfRect } from '@/lib/appearance/pdf/types.js';
import type { AppearancePdfControls } from './pdf-controls.js';

const mmPerPoint = 25.4 / 72;
const displayMm = (points: number) => String(Math.round(points * mmPerPoint * 1000) / 1000);

function Margin({ name, value, maximum, onChange, onInvalid }: {
  name: string; value: number; maximum: number; onChange(value: number): void;
  onInvalid(name: string, invalid: boolean): void;
}) {
  const [text, setText] = useState(displayMm(value));
  const invalid = text.trim() === '' || !Number.isFinite(Number(text)) || Number(text) < 0 || Number(text) >= maximum * mmPerPoint;
  useEffect(() => { setText(displayMm(value)); onInvalid(name, false); }, [value, name, onInvalid]);
  useEffect(() => () => onInvalid(name, false), [name, onInvalid]);
  return <label className="block space-y-1 text-[11px] text-muted-foreground"><span>{name} (mm)</span>
    <Input aria-label={`PDF crop ${name.toLowerCase()} margin (mm)`} type="number" min="0" step="any"
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
      <div role="group" aria-label="PDF crop preview" tabIndex={0}
        className={`relative mx-auto w-full overflow-hidden bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring ${disabled ? 'opacity-60' : 'cursor-crosshair'}`}
        style={{ aspectRatio: `${width}/${height}`, maxWidth: 240 * width / height, touchAction: disabled ? 'auto' : 'none' }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setDrag(null); } }}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          const start = point(event); if (!start.every(Number.isFinite)) return;
          event.preventDefault(); event.currentTarget.focus();
          event.currentTarget.setPointerCapture?.(event.pointerId);
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
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setDrag(null);
        }}>
        <img src={pdf.pagePreviewUrl} alt={`Page ${pdf.pageNumber} of ${pdf.documentName}`} draggable={false} className="pointer-events-none block h-full w-full select-none" />
        <div aria-hidden="true" className="pointer-events-none absolute border-2 border-primary bg-primary/5"
          style={{ left: `${shown[0] / width * 100}%`, top: `${shown[1] / height * 100}%`, width: `${shown[2] / width * 100}%`, height: `${shown[3] / height * 100}%`, boxShadow: '0 0 0 999px rgb(0 0 0 / 35%)' }} />
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">Drag over the page to crop. Escape cancels the selection.</p>
    </div>}
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-medium">Page crop</span>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}
        onClick={() => { setReset(value => value + 1); pdf.onCropChange([0, 0, width, height]); }}>Use full page</Button>
    </div>
    <fieldset disabled={disabled} className="grid grid-cols-2 gap-2" aria-label="PDF crop paper margins">
      <Margin key={`${reset}:Left`} name="Left" value={left} maximum={width - right} onInvalid={onInvalid} onChange={value => pdf.onCropChange([value, top, width - value - right, cropHeight])} />
      <Margin key={`${reset}:Top`} name="Top" value={top} maximum={height - bottom} onInvalid={onInvalid} onChange={value => pdf.onCropChange([left, value, cropWidth, height - value - bottom])} />
      <Margin key={`${reset}:Right`} name="Right" value={right} maximum={width - left} onInvalid={onInvalid} onChange={value => pdf.onCropChange([left, top, width - left - value, cropHeight])} />
      <Margin key={`${reset}:Bottom`} name="Bottom" value={bottom} maximum={height - top} onInvalid={onInvalid} onChange={value => pdf.onCropChange([left, top, cropWidth, height - top - value])} />
    </fieldset>
    <p className="text-[10px] leading-relaxed text-muted-foreground">Margins use paper millimetres. Drawing scale is calibrated separately.</p>
  </div>;
}
