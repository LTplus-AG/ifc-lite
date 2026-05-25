/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One axis row inside the Geometry edit card's position section.
 * X / Y / Z labelled input bracketed by ±step nudge buttons.
 * Purely presentational — caller wires the input value, change
 * handler, and the two nudge callbacks.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface AxisRowProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onNudgeMinus: () => void;
  onNudgePlus: () => void;
}

export function GeometryAxisRow({ label, value, onChange, onNudgeMinus, onNudgePlus }: AxisRowProps) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-4 text-[11px] font-mono text-purple-700 dark:text-purple-400">{label}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-6 w-6 text-purple-600"
        onClick={onNudgeMinus}
        aria-label={`Decrease ${label}`}
      >
        −
      </Button>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 text-xs font-mono px-1 flex-1 border-purple-200 dark:border-purple-800/60 bg-white dark:bg-zinc-950"
        step="any"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-6 w-6 text-purple-600"
        onClick={onNudgePlus}
        aria-label={`Increase ${label}`}
      >
        +
      </Button>
    </div>
  );
}
