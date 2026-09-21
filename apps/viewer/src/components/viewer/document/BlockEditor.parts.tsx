/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Inputs the block editors share (#4940, #5142): the field class, the width picker, the clamped number. */
import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';
import type { BlockWidth } from '@/lib/document/types';

export const field = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs';

/** Chart and image blocks share this "two-up" width picker (#4940). */
export function WidthEditor({ width, onChange }: { width: BlockWidth | undefined; onChange: (width: BlockWidth) => void }) {
  const { t } = useTranslation();
  return (
    <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.block.widthLabel')}
      <select className={field} value={width ?? 'full'} onChange={(e) => onChange(e.target.value as BlockWidth)} aria-label={t('document.block.widthAriaLabel')} title={t('document.block.widthTitle')}>
        <option value="full">{t('document.block.widthFull')}</option><option value="half">{t('document.block.widthHalf')}</option>
      </select>
    </label>
  );
}

/**
 * A number input that clamps on blur/Enter, not on every keystroke (#4940 review): clamping
 * immediately rewrites the field as each digit lands (typing "300" clamped to 120 after the "3",
 * then the "0" landed on "120" making "1200"), so a typed value like 300 could never be reached.
 * The raw text is kept in local state; `onCommit` only fires the clamped number once editing ends.
 */
export function ClampedNumberInput({ value, min, max, placeholder, ariaLabel, allowUndefined, onCommit }: { value: number | undefined; min: number; max: number; placeholder?: string; ariaLabel: string; allowUndefined?: boolean; onCommit: (value: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => { setText(value === undefined ? '' : String(value)); }, [value]);
  const commit = (): void => {
    const trimmed = text.trim();
    if (trimmed === '') {
      const next = allowUndefined ? undefined : min;
      setText(next === undefined ? '' : String(next));
      onCommit(next);
      return;
    }
    const raw = Number(trimmed);
    const clamped = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : (value ?? min);
    setText(String(clamped));
    onCommit(clamped);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      className={`${field} w-16`}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      aria-label={ariaLabel}
    />
  );
}
