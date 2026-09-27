/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One axis row inside the Geometry edit card's position section.
 * X / Y / Z labelled input bracketed by ±step nudge buttons.
 * Purely presentational — caller wires the input value, change
 * handler, and the two nudge callbacks.
 */

import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n';

interface AxisRowProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onNudgeMinus: () => void;
  onNudgePlus: () => void;
}

export function GeometryAxisRow({ label, value, onChange, onNudgeMinus, onNudgePlus }: AxisRowProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      <span className="w-4 text-[11px] font-mono text-muted-foreground">{label}</span>
      <IconButton
        label={t('geometryAxisRow.decreaseAriaLabel', { label })}
        variant="ghost"
        size="icon-xs"
        className="h-6 w-6 text-overlay-accent"
        onClick={onNudgeMinus}
      >
        −
      </IconButton>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 text-xs font-mono px-1 flex-1 border-overlay-accent/40 bg-white dark:bg-zinc-950"
        step="any"
      />
      <IconButton
        label={t('geometryAxisRow.increaseAriaLabel', { label })}
        variant="ghost"
        size="icon-xs"
        className="h-6 w-6 text-overlay-accent"
        onClick={onNudgePlus}
      >
        +
      </IconButton>
    </div>
  );
}
