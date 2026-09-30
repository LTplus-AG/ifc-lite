/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { OptionalColorPicker } from './OptionalColorPicker';
import { TEXT_STYLES } from '@/lib/document/compose';
import type { TextBlock } from '@/lib/document/types';

/** Optional RGB overrides; reset keeps the style's defaults meaningful (#6492). */
export function TextColorEditor({ block, onChange }: { block: TextBlock; onChange: (block: TextBlock) => void }) {
  const { t } = useTranslation();
  const gray = TEXT_STYLES[block.style].gray.toString(16).padStart(2, '0');
  return <div className="flex flex-wrap items-center gap-2">
    {(['textColor', 'backgroundColor'] as const).map((key) => {
      const label = t(key === 'textColor' ? 'document.block.textColorLabel' : 'document.block.backgroundColorLabel');
      return <OptionalColorPicker key={key} label={label}
        resetLabel={t(key === 'textColor' ? 'document.block.textColorReset' : 'document.block.backgroundColorReset')}
        value={block[key]} defaultValue={key === 'textColor' ? `#${gray.repeat(3)}` : '#ffffff'}
        onChange={(value) => onChange({ ...block, [key]: value })} />;
    })}
  </div>;
}
