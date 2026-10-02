/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { TEXT_SIZE_MIN, TEXT_SIZE_MAX, type DocumentSpec, type TextFont } from '@/lib/document/types';
import { PAGE_HEADING_DEFAULTS } from '@/lib/document/page-heading';
import { PAGE_LOGO_HEIGHT_DEFAULT, PAGE_LOGO_HEIGHT_MIN, PAGE_LOGO_HEIGHT_MAX, type PageBand } from '@/lib/document/page-band';
import { readImageFile } from '@/lib/document/persistence';
import { ClampedNumberInput, field } from './BlockEditor.parts';
import { OptionalColorPicker } from './OptionalColorPicker';

function PageBandEditor({ document, band, onChange }: { document: DocumentSpec; band: 'pageHeading' | 'pageFooter';
  onChange: (document: DocumentSpec) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const latest = useRef({ document, onChange });
  latest.current = { document, onChange };
  const uploadVersion = useRef(0);
  useEffect(() => { uploadVersion.current++; setBusy(false);
    return () => { uploadVersion.current++; };
  }, [document.id]);
  const spec = document[band] ?? {};
  const key = band === 'pageHeading' ? 'document.pageHeading' : 'document.pageFooter';
  const update = (next: Partial<PageBand>) => onChange({ ...document, [band]: { ...spec, ...next } });
  const pickLogo = async (file: File | undefined) => {
    if (!file) return;
    const ownerId = document.id, version = ++uploadVersion.current;
    setBusy(true);
    try {
      const dataUrl = await readImageFile(file);
      const current = latest.current;
      if (current.document.id !== ownerId || uploadVersion.current !== version) return;
      current.onChange({ ...current.document, [band]: { ...current.document[band],
        logo: { dataUrl, height: current.document[band]?.logo?.height ?? PAGE_LOGO_HEIGHT_DEFAULT } } });
    }
    catch (error) {
      if (uploadVersion.current === version) toast.error(error instanceof Error ? error.message : t('document.block.imageReadError'));
    }
    finally { if (uploadVersion.current === version) setBusy(false); }
  };
  return <details className="rounded border border-border p-2" data-page-heading-editor={band === 'pageHeading' ? '' : undefined}
    data-page-footer-editor={band === 'pageFooter' ? '' : undefined}>
    <summary className="cursor-pointer font-medium">{t(`${key}.label`)}</summary>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label className="w-full text-muted-foreground">{t(`${key}.text`)}
        <input className={`${field} mt-1 w-full`} value={spec.text ?? (band === 'pageHeading' ? document.name : '')}
          aria-label={t(`${key}.text`)} onChange={event => update({ text: event.target.value })} />
      </label>
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.fontLabel')}
        <select className={field} value={spec.font ?? PAGE_HEADING_DEFAULTS.font} aria-label={t(`${key}.font`)}
          onChange={event => update({ font: event.target.value as TextFont })}>
          <option value="helvetica">{t('document.block.fontHelvetica')}</option><option value="times">{t('document.block.fontTimes')}</option><option value="courier">{t('document.block.fontCourier')}</option>
        </select>
      </label>
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.fontSizeLabel')}
        <ClampedNumberInput value={spec.fontSize} min={TEXT_SIZE_MIN} max={TEXT_SIZE_MAX} allowUndefined placeholder={String(PAGE_HEADING_DEFAULTS.fontSize)}
          ariaLabel={t(`${key}.size`)} onCommit={fontSize => update({ fontSize })} />
      </label>
      <OptionalColorPicker label={t(`${key}.color`)} resetLabel={t(`${key}.resetColor`)}
        value={spec.textColor} defaultValue={PAGE_HEADING_DEFAULTS.textColor} onChange={textColor => update({ textColor })} />
      <label className="inline-flex items-center gap-1 text-muted-foreground">
        <input type="checkbox" checked={spec.showDate ?? false} aria-label={t(`${key}.date`)}
          onChange={event => update({ showDate: event.target.checked })} />{t(`${key}.date`)}
      </label>
      <label className="inline-flex items-center gap-1 text-muted-foreground">
        <input type="checkbox" checked={spec.showPageNumbers ?? band === 'pageFooter'} aria-label={t(`${key}.pageNumbers`)}
          onChange={event => update({ showPageNumbers: event.target.checked })} />{t(`${key}.pageNumbers`)}
      </label>
      <label className="w-full text-muted-foreground">{t(`${key}.logo`)}
        <input className={`${field} mt-1 w-full`} type="file" accept="image/png,image/jpeg" disabled={busy}
          aria-label={t(`${key}.logo`)} onChange={event => { void pickLogo(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
      {spec.logo && <>
        <ClampedNumberInput value={spec.logo.height} min={PAGE_LOGO_HEIGHT_MIN} max={PAGE_LOGO_HEIGHT_MAX}
          ariaLabel={t(`${key}.logoHeight`)} onCommit={height => update({ logo: { ...spec.logo!, height: height ?? PAGE_LOGO_HEIGHT_DEFAULT } })} />
        <Button variant="ghost" size="sm" aria-label={t(`${key}.removeLogo`)} onClick={() => update({ logo: undefined })}>{t(`${key}.removeLogo`)}</Button>
      </>}
      <Button variant="ghost" size="sm" disabled={document[band] === undefined} aria-label={t(`${key}.reset`)}
        onClick={() => onChange({ ...document, [band]: undefined })}>{t(`${key}.reset`)}</Button>
    </div>
  </details>;
}

export function PageHeadingEditor(props: { document: DocumentSpec; onChange: (document: DocumentSpec) => void }) {
  return <><PageBandEditor {...props} band="pageHeading" /><PageBandEditor {...props} band="pageFooter" /></>;
}
