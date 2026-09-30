/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import type { BlockTitle } from '@/lib/document/block-title';
import { field } from './BlockEditor.parts';

export function BlockTitleEditor<T extends BlockTitle>({ block, onChange, placeholder, table = false }: {
  block: T; onChange: (block: T) => void; placeholder?: string; table?: boolean;
}) {
  const { t } = useTranslation();
  return <input className={`${field} min-w-0 flex-1`} value={block.title ?? ''}
    placeholder={placeholder ?? t('document.block.titlePlaceholder')}
    onChange={(event) => onChange({ ...block, title: event.target.value || undefined })}
    aria-label={t(table ? 'document.block.tableTitleAriaLabel' : 'document.block.titleAriaLabel')} />;
}
