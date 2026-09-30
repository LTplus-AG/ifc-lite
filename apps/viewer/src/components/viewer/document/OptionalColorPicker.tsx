/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';

/** A persisted optional RGB override, with an explicit reset to its default. */
export function OptionalColorPicker({ label, resetLabel, value, defaultValue, onChange }: {
  label: string; resetLabel: string; value: string | undefined; defaultValue: string;
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  return <div className="inline-flex items-center gap-1">
    <label className="inline-flex items-center gap-1 text-muted-foreground">
      {label}
      <input type="color" className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0.5" aria-label={label}
        value={value ?? defaultValue} onChange={(event) => onChange(event.target.value)} />
    </label>
    <Button variant="ghost" size="sm" className="h-6 px-1" disabled={value === undefined}
      aria-label={resetLabel} onClick={() => onChange(undefined)}>{t('document.block.colorReset')}</Button>
  </div>;
}
