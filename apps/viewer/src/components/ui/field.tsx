/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `<Field label hint error>{control}</Field>` (#5812): a single labelled
 * form field.
 *
 * `Field` owns one `useId()`-generated id and wires it onto BOTH the visible
 * `<label>` (`htmlFor`, and its own `id` for `aria-labelledby`) and the
 * single child control (`id`, `aria-describedby`, `aria-invalid`), cloning
 * those directly onto `children` — which works for a native `<input>`/
 * `<select>`/`<textarea>`, or any `forwardRef` component that spreads its
 * remaining props onto one (`Input`, `Textarea`, `Checkbox`, `ComboInput`).
 *
 * A Radix `Select` is different: `Select` is `SelectPrimitive.Root`, which
 * renders no DOM node of its own, so cloning props onto it lands on a
 * component that never uses them — the real, focusable element is
 * `SelectTrigger`, an arbitrarily-nested descendant `Field` cannot reach by
 * cloning. `Field` also provides those same four values through
 * `FieldContext`, and `ui/select.tsx`'s `SelectTrigger` reads it (falling
 * back only when it has no explicit id/aria-* of its own) and applies them
 * to the actual trigger button, plus `aria-labelledby` pointing at the
 * label's own id — a `<button>` (what `SelectTrigger` renders) computes its
 * accessible name from its content by default, not from an `htmlFor`
 * association, so `aria-labelledby` is what actually names it after the
 * field label.
 *
 * `hint` and `error` each render as an id'd paragraph and get folded into
 * the control's `aria-describedby` (both, when present); `error` also sets
 * `aria-invalid="true"` and is announced (`role="alert"`).
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface FieldContextValue {
  /** Id to apply to the actual control element (matches the label's `htmlFor`). */
  id: string;
  /** Id of the `<label>` itself, for `aria-labelledby`. */
  labelId: string;
  describedBy?: string;
  invalid?: true;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

/** Consumed by controls (e.g. `SelectTrigger`) that `Field` cannot label by cloning props onto them directly. */
export function useFieldContext(): FieldContextValue | null {
  return React.useContext(FieldContext);
}

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
  const labelId = `${controlId}-label`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const invalid = !!error;

  const describedBy = [
    children.props['aria-describedby'],
    hint ? hintId : null,
    error ? errorId : null,
  ].filter(Boolean).join(' ') || undefined;

  const control = React.cloneElement(children, {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-invalid': invalid ? true : children.props['aria-invalid'],
  });

  const contextValue = React.useMemo<FieldContextValue>(
    () => ({ id: controlId, labelId, describedBy, invalid: invalid ? true : undefined }),
    [controlId, labelId, describedBy, invalid],
  );

  const labelEl = (
    <label id={labelId} htmlFor={controlId} className={cn('text-sm font-medium leading-none', labelClassName)}>
      {label}
    </label>
  );

  return (
    <FieldContext.Provider value={contextValue}>
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
    </FieldContext.Provider>
  );
}
