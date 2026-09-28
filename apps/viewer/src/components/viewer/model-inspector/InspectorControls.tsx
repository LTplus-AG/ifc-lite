/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model inspector's building blocks (charter #6232, M2.5): a titled
 * section, a label ‖ control row, a committed text field, and the compact
 * two-way pill. Sizes stay on the text-xs / text-2xs scale of the side
 * panels.
 */

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function InspectorSection({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-2 border-b border-border px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id={id} className="text-xs font-medium text-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function InspectorCaption({ children }: { children: ReactNode }) {
  return <p className="text-2xs leading-snug text-muted-foreground">{children}</p>;
}

/** A label and its control on one line; `htmlFor` names the control. */
export function InspectorRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
      {htmlFor
        ? <label htmlFor={htmlFor} className="truncate text-2xs text-muted-foreground">{label}</label>
        : <span className="truncate text-2xs text-muted-foreground">{label}</span>}
      {children}
    </div>
  );
}

interface CommitFieldProps {
  id?: string;
  value: string;
  /** Return false to refuse the text; the field then shows `value` again. */
  onCommit: (text: string) => boolean | void;
  ariaLabel?: string;
  placeholder?: string;
  suffix?: string;
  readOnly?: boolean;
  className?: string;
}

/**
 * A text field that writes on Enter or blur and reverts on Escape, so typing
 * is never a stream of undo steps. Follows `value` while not being edited.
 */
export function CommitField({ id, value, onCommit, ariaLabel, placeholder, suffix, readOnly, className }: CommitFieldProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft === value) return;
    if (onCommit(draft) === false) setDraft(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation(); // workspace keys (W, E, S) must not fire while typing
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur(); }
  };
  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className={cn('h-7 text-xs tabular-nums', suffix && 'pr-6', readOnly && 'bg-muted/40 text-muted-foreground')}
      />
      {suffix && <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

export interface PillOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

/** Two or three exclusive choices, text-2xs, the side-panel sibling of `HudSegmented`. */
export function InspectorPill<V extends string>({ label, value, options, onChange }: {
  label: string; value: V; options: readonly PillOption<V>[]; onChange: (value: V) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
            option.value === value && 'bg-background text-foreground shadow-sm',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
