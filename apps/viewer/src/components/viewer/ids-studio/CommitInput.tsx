/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A text field that edits a local draft and commits once, on blur or Enter
 * (Escape reverts). One commit is one op batch and one undo step, rather than
 * a history entry per keystroke. A new `value` from the store (undo, another
 * editor) replaces the draft.
 */

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

interface CommitInputProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
  /** Native input type; `date` gives the browser date picker (IDS wants xs:date). */
  type?: 'text' | 'email' | 'date';
}

const inputClass = 'w-full rounded border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50';

export function CommitInput({ label, value, onCommit, multiline, placeholder, hint, disabled, className, type = 'text' }: CommitInputProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { setDraft(value); return; }
    if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
  };
  return <div className={cn('space-y-0.5', className)}>
    <label htmlFor={id} className="block text-2xs text-muted-foreground">{label}</label>
    {multiline
      ? <textarea id={id} rows={2} className={cn(inputClass, 'resize-y')} value={draft} placeholder={placeholder} disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
      : <input id={id} type={type} className={cn(inputClass, 'h-7')} value={draft} placeholder={placeholder} disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />}
    {hint && <p id={`${id}-hint`} className="text-2xs text-muted-foreground">{hint}</p>}
  </div>;
}
