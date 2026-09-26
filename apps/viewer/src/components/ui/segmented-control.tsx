/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentOption<Value extends string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

interface SegmentedControlProps<Value extends string> {
  label: string;
  value: Value;
  options: readonly SegmentOption<Value>[];
  onValueChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
}

/** An exclusive choice with radio semantics and one arrow-key focus stop. */
export function SegmentedControl<Value extends string>({
  label, value, options, onValueChange, disabled, className,
}: SegmentedControlProps<Value>) {
  const name = useId();
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    const available = options.map((option, index) => !option.disabled ? index : -1).filter((index) => index >= 0);
    if (available.length === 0) return;
    event.preventDefault();
    const selected = available.findIndex((index) => options[index]?.value === value);
    const current = selected >= 0 ? selected
      : available.findIndex((index) => inputs.current[index] === event.target);
    const next = event.key === 'Home' ? available[0]
      : event.key === 'End' ? available[available.length - 1]
        : available[(current + direction + available.length) % available.length];
    if (next === undefined) return;
    onValueChange(options[next].value);
    inputs.current[next]?.focus();
  };

  return (
    <fieldset role="radiogroup" aria-label={label} disabled={disabled} onKeyDown={onKeyDown} className={cn('inline-flex rounded-md border p-0.5', className)}>
      <legend className="sr-only">{label}</legend>
      {options.map((option, index) => (
        <label key={option.value} className="relative cursor-pointer disabled:cursor-not-allowed">
          <input
            ref={(node) => { inputs.current[index] = node; }}
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onValueChange(option.value)}
            className="peer sr-only"
          />
          <span className="block rounded px-3 py-1 text-sm text-muted-foreground transition-colors peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-ring peer-disabled:opacity-50">
            {option.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
