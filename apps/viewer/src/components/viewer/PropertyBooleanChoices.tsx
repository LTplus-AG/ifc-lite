/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId } from 'react';
import { useTranslation } from '@/i18n';

/** IFC optional Boolean/Logical values include an explicit unset choice. */
export function PropertyBooleanChoices({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const name = useId();
  const choices = [
    ['', t('propertyEditor.inline.unset')],
    ['true', t('propertyEditor.inline.true')],
    ['false', t('propertyEditor.inline.false')],
  ] as const;

  return (
    <div className="flex items-center gap-1 flex-1" role="radiogroup" aria-label={t('propertyEditor.inline.booleanAria')}>
      {choices.map(([choice, label]) => (
        <label
          key={choice}
          className={`cursor-pointer px-2 py-0.5 text-xs rounded border transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-ring ${
            value === choice
              ? 'bg-overlay-accent text-overlay-halo border-overlay-accent'
              : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
          } ${choice === '' ? 'italic' : ''}`}
        >
          <input type="radio" name={name} value={choice} checked={value === choice}
            onChange={() => onChange(choice)} className="sr-only" />
          {label}
        </label>
      ))}
    </div>
  );
}
