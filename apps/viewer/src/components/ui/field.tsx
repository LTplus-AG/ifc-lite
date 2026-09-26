/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `<Field label hint error>{control}</Field>` (#5812): a single labelled
 * form field.
 *
 * `Field` owns one `useId()`-generated id and wires it onto BOTH the visible
 * `<label>` (`htmlFor`) and the single child control (`id`), so the control
 * cannot render unlabelled: there is no prop to opt out of the association.
 * `hint` and `error` each render as an id'd paragraph and get folded into the
 * control's `aria-describedby` (both, when both are present); `error` also
 * sets the control's `aria-invalid="true"` and is announced (`role="alert"`)
 * since it usually appears after a failed submit, not on first render.
 *
 * `children` must be a single React element (a native `<input>`/`<select>`/
 * `<textarea>`, or a `forwardRef` component that spreads its remaining props
 * onto one — this repo's `Input`/`Textarea`/`Select` all do). `Field` clones
 * it with the generated `id`/`aria-describedby`/`aria-invalid`, preferring an
 * `id` the control already carries (so a caller that already generated one,
 * e.g. to target it from a ref, is not overridden) and merging onto rather
 * than replacing any `aria-describedby` the control set itself.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface FieldProps {
  /** The visible field label, associated with the control via `htmlFor`. */
  label: React.ReactNode;
  /** An action rendered beside the label (e.g. a "use custom name" toggle) — not part of the label text itself. */
  labelAction?: React.ReactNode;
  /** Supplementary guidance shown below the control at all times. */
  hint?: React.ReactNode;
  /** Validation message; also flips `aria-invalid` on the control. */
  error?: React.ReactNode;
  className?: string;
  labelClassName?: string;
  /** The single form control this field labels. */
  children: React.ReactElement<{
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean | 'true' | 'false';
  }>;
}

export function Field({ label, labelAction, hint, error, className, labelClassName, children }: FieldProps) {
  const generatedId = React.useId();
  const controlId = children.props.id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;

  const describedBy = [
    children.props['aria-describedby'],
    hint ? hintId : null,
    error ? errorId : null,
  ].filter(Boolean).join(' ') || undefined;

  const control = React.cloneElement(children, {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : children.props['aria-invalid'],
  });

  const labelEl = (
    <label htmlFor={controlId} className={cn('text-sm font-medium leading-none', labelClassName)}>
      {label}
    </label>
  );

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {labelAction ? (
        <div className="flex items-center justify-between gap-2">
          {labelEl}
          {labelAction}
        </div>
      ) : labelEl}
      {control}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
