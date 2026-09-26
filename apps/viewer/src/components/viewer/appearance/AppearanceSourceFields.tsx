/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useId, useRef, useState } from 'react';
import { ImagePlus, Upload, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { DEFAULT_APPEARANCE_ASSET_LIMITS as limits } from '@/lib/appearance/asset-format.js';
import type { AppearancePanelViewProps } from './types.js';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export const appearanceSelectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50';
export function AppearanceSourceFields(props: Pick<AppearancePanelViewProps,
  'allowPdf' | 'sources' | 'sourceId' | 'onSourceChange' | 'onRemoveSource' | 'onUpload' | 'sourceBusy' | 'sourceHelp'> & { disabled: boolean }) {
  const { t, locale } = useTranslation();
  const picker = useRef<HTMLInputElement>(null);
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const source = props.sources.find(source => source.id === props.sourceId);
  const disabled = props.disabled || props.sourceBusy;
  return <section className="space-y-2" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="text-xs font-medium">{props.allowPdf ? t('appearance.sourceFields.headingSource') : t('appearance.sourceFields.headingSourceImage')}</h3>
    <div className={`rounded-lg border border-dashed p-3 transition-colors ${dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20'}`}
      onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop={event => {
        event.preventDefault(); setDragging(false);
        const file = event.dataTransfer?.files[0];
        if (!disabled && file) props.onUpload(file);
      }}>
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background">
          {source?.thumbnailUrl ? <img src={source.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={source?.name}>{source?.name ?? (props.allowPdf ? t('appearance.sourceFields.addImageOrPdf') : t('appearance.sourceFields.addImageToBegin'))}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">{source ? t('appearance.sourceFields.dimensionsPx', { width: formatLocaleNumber(locale, source.width), height: formatLocaleNumber(locale, source.height) }) : props.allowPdf ? t('appearance.sourceFields.dropPdfHint') : t('appearance.sourceFields.dropImageHint')}</p>
          <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-0 text-primary" disabled={disabled} onClick={() => picker.current?.click()}>
            <Upload aria-hidden="true" />{props.sourceBusy ? (props.allowPdf ? t('appearance.sourceFields.readingSource') : t('appearance.sourceFields.readingImage')) : source ? (props.allowPdf ? t('appearance.sourceFields.uploadAnotherSource') : t('appearance.sourceFields.uploadAnotherImage')) : (props.allowPdf ? t('appearance.sourceFields.chooseImageOrPdf') : t('appearance.sourceFields.chooseImage'))}
          </Button>
        </div>
        {source && props.onRemoveSource && <IconButton
   label={props.allowPdf ? t('appearance.sourceFields.removeSource') : t('appearance.sourceFields.removeSourceImage')}
   type="button"
   size="icon-xs"
   disabled={disabled}
   onClick={() => props.onRemoveSource?.(source.id)}
 ><Trash2 aria-hidden="true" /></IconButton>}
      </div>
      <input ref={picker} id={`${id}-file`} type="file" accept={props.allowPdf ? 'image/png,image/jpeg,application/pdf,.png,.jpg,.jpeg,.pdf' : 'image/png,image/jpeg,.png,.jpg,.jpeg'} className="sr-only" tabIndex={-1}
        aria-label={props.allowPdf ? t('appearance.sourceFields.uploadSourceAriaLabel') : t('appearance.sourceFields.uploadImageAriaLabel')} disabled={disabled} onChange={event => {
          const file = event.currentTarget.files?.[0];
          if (file) props.onUpload(file);
          event.currentTarget.value = '';
        }} />
    </div>
    {props.sources.length > 0 && (props.sources.length > 1 || !source) && <label className="block space-y-1 text-2xs text-muted-foreground">
      <span>{props.allowPdf ? t('appearance.sourceFields.reuseSource') : t('appearance.sourceFields.reuseImage')}</span>
      <select aria-label={props.allowPdf ? t('appearance.sourceFields.reuseSource') : t('appearance.sourceFields.reuseImage')} className={appearanceSelectClass} value={source?.id ?? ''} disabled={disabled} onChange={event => props.onSourceChange(event.target.value)}>
        {!source && <option value="" disabled>{props.allowPdf ? t('appearance.sourceFields.chooseSourceOption') : t('appearance.sourceFields.chooseImageOption')}</option>}
        {props.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select>
    </label>}
    <p className="text-2xs leading-relaxed text-muted-foreground">{props.sourceHelp ?? (props.allowPdf ? t('appearance.sourceFields.helpPdf') : t('appearance.sourceFields.helpImage', {
      maxMb: limits.maxImageBytes / 1048576,
      maxMegapixels: formatLocaleNumber(locale, limits.maxPixels / 1e6, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      maxDimension: formatLocaleNumber(locale, limits.maxDimension),
    }))}</p>
  </section>;
}
