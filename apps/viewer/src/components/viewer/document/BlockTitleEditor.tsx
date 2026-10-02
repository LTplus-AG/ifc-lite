/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { BLOCK_TITLE_SIZE_DEFAULT, BLOCK_TITLE_SIZE_MAX, BLOCK_TITLE_SIZE_MIN, blockTitleStyle, type BlockTitle } from '@/lib/document/block-title';
import { ClampedNumberInput, field } from './BlockEditor.parts';
import { OptionalColorPicker } from './OptionalColorPicker';

/**
 * The heading controls every block kind with a heading shares (#6632): its text, size, ink and
 * background. One component edits one `BlockTitle`, so a kind cannot grow its own variant.
 */
export function BlockTitleEditor<T extends BlockTitle>({ block, onChange, placeholder, table = false }: {
  block: T; onChange: (block: T) => void; placeholder?: string; table?: boolean;
}) {
  const { t } = useTranslation();
  const style = blockTitleStyle(block);
  return <div className="flex min-w-0 flex-1 flex-col gap-1" data-block-title-editor>
    <input className={`${field} min-w-0 flex-1`} value={block.title ?? ''}
      placeholder={placeholder ?? t('document.block.titlePlaceholder')}
      onChange={(event) => onChange({ ...block, title: event.target.value || undefined })}
      aria-label={t(table ? 'document.block.tableTitleAriaLabel' : 'document.block.titleAriaLabel')} />
    <div className="flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.titleSizeLabel')}
        <ClampedNumberInput value={block.titleFontSize} min={BLOCK_TITLE_SIZE_MIN} max={BLOCK_TITLE_SIZE_MAX}
          placeholder={String(BLOCK_TITLE_SIZE_DEFAULT)} allowUndefined ariaLabel={t('document.block.titleSizeAriaLabel')}
          onCommit={(titleFontSize) => onChange({ ...block, titleFontSize })} />
      </label>
      <OptionalColorPicker label={t('document.block.titleTextColorLabel')} resetLabel={t('document.block.titleTextColorReset')}
        value={block.titleTextColor} defaultValue={style.textColor ?? '#000000'}
        onChange={(titleTextColor) => onChange({ ...block, titleTextColor })} />
      <OptionalColorPicker label={t('document.block.titleBackgroundColorLabel')} resetLabel={t('document.block.titleBackgroundColorReset')}
        value={block.titleBackgroundColor} defaultValue="#ffffff"
        onChange={(titleBackgroundColor) => onChange({ ...block, titleBackgroundColor })} />
    </div>
  </div>;
}
