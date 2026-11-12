/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_MATERIAL_COLOUR } from '@/lib/authoring/material-colour';
import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';

export function MaterialColourField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const { t } = useTranslation();
  const label = t('propertyEditor.material.colour');
  return <div className="flex items-center gap-2">
    <label htmlFor={id} className="text-xs">{label}</label>
    <Input aria-label={label} type="color" className="h-7 w-10 cursor-pointer p-0" value={/^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_MATERIAL_COLOUR} onChange={e => onChange(e.target.value)} />
    <Input id={id} aria-label={t('propertyEditor.material.colourHex')} value={value} onChange={e => onChange(e.target.value)} pattern="#[0-9a-fA-F]{6}" className="h-7 font-mono text-xs" />
  </div>;
}
