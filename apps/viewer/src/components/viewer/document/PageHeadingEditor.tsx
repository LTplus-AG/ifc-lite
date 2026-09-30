/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { TEXT_SIZE_MIN, TEXT_SIZE_MAX, type DocumentSpec, type TextFont } from '@/lib/document/types';
import { PAGE_HEADING_DEFAULTS, type PageHeading } from '@/lib/document/page-heading';
import { ClampedNumberInput, field } from './BlockEditor.parts';
import { OptionalColorPicker } from './OptionalColorPicker';

export function PageHeadingEditor({ document, onChange }: { document: DocumentSpec; onChange: (document: DocumentSpec) => void }) {
  const { t } = useTranslation();
  const heading = document.pageHeading ?? {};
  const update = (next: Partial<PageHeading>) => onChange({ ...document, pageHeading: { ...heading, ...next } });
  return <details className="rounded border border-border p-2" data-page-heading-editor>
    <summary className="cursor-pointer font-medium">{t('document.pageHeading.label')}</summary>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label className="w-full text-muted-foreground">{t('document.pageHeading.text')}
        <input className={`${field} mt-1 w-full`} value={heading.text ?? document.name}
          aria-label={t('document.pageHeading.text')} onChange={event => update({ text: event.target.value })} />
      </label>
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.fontLabel')}
        <select className={field} value={heading.font ?? PAGE_HEADING_DEFAULTS.font} aria-label={t('document.pageHeading.font')}
          onChange={event => update({ font: event.target.value as TextFont })}>
          <option value="helvetica">{t('document.block.fontHelvetica')}</option><option value="times">{t('document.block.fontTimes')}</option><option value="courier">{t('document.block.fontCourier')}</option>
        </select>
      </label>
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.fontSizeLabel')}
        <ClampedNumberInput value={heading.fontSize} min={TEXT_SIZE_MIN} max={TEXT_SIZE_MAX} allowUndefined placeholder={String(PAGE_HEADING_DEFAULTS.fontSize)}
          ariaLabel={t('document.pageHeading.size')} onCommit={fontSize => update({ fontSize })} />
      </label>
      <OptionalColorPicker label={t('document.pageHeading.color')} resetLabel={t('document.pageHeading.resetColor')}
        value={heading.textColor} defaultValue={PAGE_HEADING_DEFAULTS.textColor} onChange={textColor => update({ textColor })} />
      <Button variant="ghost" size="sm" disabled={document.pageHeading === undefined} aria-label={t('document.pageHeading.reset')}
        onClick={() => onChange({ ...document, pageHeading: undefined })}>{t('document.pageHeading.reset')}</Button>
    </div>
  </details>;
}
