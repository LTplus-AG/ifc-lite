/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The bSDD card's add control for a Qto_* row: a quantity is added with its value (#8407). */

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { parseLocaleNumber } from '@/i18n/intlFormat';
import { useTranslation } from '@/i18n';

export function BsddQuantityAdd({ name, onAdd }: { name: string; onAdd: (value: number) => void }) {
  const { t, locale } = useTranslation();
  const [text, setText] = useState('');
  const value = parseLocaleNumber(locale, text);
  const commit = () => { if (value !== null) onAdd(value); };

  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        aria-label={t('properties.bsdd.quantityValueAriaLabel', { name })}
        className="h-5 w-16 shrink-0 border border-sky-200 dark:border-sky-800 bg-transparent px-1 text-right font-mono text-2xs"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
      <IconButton
        label={t('properties.bsdd.addToElementTooltip')}
        className="h-5 w-5 p-0 shrink-0 hover:bg-sky-200 dark:hover:bg-sky-800"
        disabled={value === null}
        onClick={commit}
      >
        <Plus className="h-3 w-3 text-sky-600 dark:text-sky-400" />
      </IconButton>
    </>
  );
}
