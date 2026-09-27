/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Numeric dimension input for the Add Element panel (#6233).
 *
 * The field keeps what the user is typing as a local draft and only commits
 * a value once the text parses to a number at or above `min`. Intermediate
 * text ("", "0", "0.") stays visible instead of being dropped, so replacing
 * 0.15 with 0.3 types as expected. Blur or Enter drops an invalid draft and
 * shows the last committed value again.
 *
 * `step="any"`: a fixed step with a small `min` marks ordinary values such as
 * 0.2 or 3 as step mismatches (invalid), because steps count from `min`.
 */

import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  onChange: (v: number) => void;
}

function parseAtLeast(text: string, min: number): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const next = Number(trimmed);
  return Number.isFinite(next) && next >= min ? next : null;
}

export function NumberField({ label, value, min, onChange }: NumberFieldProps) {
  const id = useId();
  // null = not editing: the field shows the committed value.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Number.isFinite(value) ? String(value) : '');
  const invalid = draft !== null && parseAtLeast(draft, min) === null;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-2xs font-mono text-zinc-500 dark:text-zinc-400">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        step="any"
        min={min}
        value={shown}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const next = parseAtLeast(e.target.value, min);
          if (next !== null && next !== value) onChange(next);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setDraft(null);
        }}
        className="h-8 font-mono text-xs"
      />
    </div>
  );
}
