/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One inline storey field (#9013): it looks like text until focused. Enter
 * commits, Escape cancels, blur commits. `onDraft` reports every keystroke so
 * the manager can preview the edit; the validation message sits right under
 * the field and is announced.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface StoreyInlineFieldProps {
  value: string;
  label: string;
  /** Unit symbol after the value; a symbol, not copy. */
  suffix?: string;
  readOnly?: boolean;
  /** Every keystroke, for live validation and preview. */
  onDraft?: (text: string) => void;
  /** Commit the text; false refuses it (the caller shows why). */
  onCommit: (text: string) => boolean;
  onCancel?: () => void;
  error?: string | null;
  align?: 'start' | 'end';
  className?: string;
  inputRef?: (element: HTMLInputElement | null) => void;
  dataField?: string;
}

export function StoreyInlineField({
  value, label, suffix, readOnly, onDraft, onCommit, onCancel, error, align = 'start', className, inputRef, dataField,
}: StoreyInlineFieldProps) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const errorId = useId();
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);

  // Enter keeps a refused value in the field, with its message, to fix it.
  // Blur and Escape put the stored value back.
  const commit = (): boolean => {
    if (draft === value) { onCancel?.(); return true; }
    return onCommit(draft);
  };
  const revert = () => { setDraft(value); onCancel?.(); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation(); // workspace keys (W, E, S, PageUp) must not fire while typing
    if (event.key === 'Enter') {
      event.preventDefault();
      if (commit()) { editing.current = false; event.currentTarget.blur(); }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editing.current = false;
      revert();
      event.currentTarget.blur();
    }
  };
  const onBlur = () => {
    if (!editing.current) return;
    editing.current = false;
    if (!commit()) revert();
  };

  return (
    <div className={cn('min-w-0', className)}>
      <div className="relative">
        <Input
          ref={inputRef}
          value={draft}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          readOnly={readOnly}
          data-storey-field={dataField}
          onFocus={(event) => { if (!readOnly) { editing.current = true; event.currentTarget.select(); } }}
          onChange={(event) => { setDraft(event.target.value); onDraft?.(event.target.value); }}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          className={cn(
            'h-7 border-transparent bg-transparent px-1.5 text-xs tabular-nums shadow-none',
            'hover:border-input focus-visible:border-input focus-visible:bg-background',
            align === 'end' && 'text-right',
            suffix && 'pr-5',
            error && 'border-danger-border focus-visible:ring-danger',
            readOnly && 'hover:border-transparent',
          )}
        />
        {suffix && (
          <span aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-2xs text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-0.5 text-2xs leading-snug text-danger">{error}</p>
      )}
    </div>
  );
}
