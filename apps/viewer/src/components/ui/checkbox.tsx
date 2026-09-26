/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A native, styled checkbox (#5812): `checked`/`indeterminate` are props the
 * caller owns (controlled), `onCheckedChange` reports the next boolean.
 *
 * `indeterminate` is a DOM property, not an HTML attribute (there is no
 * `indeterminate=` you can set in JSX), so it is applied imperatively to the
 * underlying `<input>` in an effect; that also means it is invisible to
 * screen readers unless the browser derives the accessible state from that
 * same DOM property, which every current one does — an explicit
 * `aria-checked="mixed"` would fight that native computation rather than
 * help it, so this deliberately sets neither `aria-checked` nor `role`.
 *
 * `label` (optional) wraps the input in a `<label>`, the same
 * label-wraps-control association `<Field>` uses `htmlFor`/`id` for; a
 * `Checkbox` with no `label` is expected to be labelled by a surrounding
 * `<Field>` or an explicit `aria-label` instead.
 *
 * `description`, when given, renders inside that same `<label>` (so
 * clicking it still toggles the checkbox) but must NOT become part of the
 * checkbox's accessible NAME — label-wraps-control name computation uses
 * the label's entire text content, description included, unless overridden.
 * So the input gets an explicit `aria-labelledby` pointing at only the
 * `label` text's own id (which wins over the implicit wrapping-label
 * name), and a separate `aria-describedby` pointing at `description`'s id
 * — named by `label` alone, described by `label` + `description` together.
 *
 * Space toggles it via an explicit `onKeyDown`, not the browser's native
 * default action: this is a CONTROLLED input (`checked` always comes from
 * the caller), so a native toggle followed by React re-asserting the old
 * `checked` value would visually snap back. `preventDefault` suppresses the
 * native toggle and `onCheckedChange` is called directly instead, giving one
 * deterministic toggle in every environment (browser or test DOM) rather
 * than relying on a browser-native behaviour a headless DOM does not
 * reproduce.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange'> {
  checked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Visible label; wraps the input in a `<label>` when given. */
  label?: React.ReactNode;
  /** Secondary text shown under `label`, inside the same `<label>`. */
  description?: React.ReactNode;
  containerClassName?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      className,
      containerClassName,
      checked = false,
      indeterminate = false,
      onCheckedChange,
      label,
      description,
      id,
      onKeyDown,
      disabled,
      'aria-labelledby': ariaLabelledBy,
      'aria-describedby': ariaDescribedBy,
      ...props
    },
    ref
  ) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const labelId = `${inputId}-label`;
    const descriptionId = `${inputId}-description`;
    const innerRef = React.useRef<HTMLInputElement | null>(null);

    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);

    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    const handleKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(event);
        if (disabled) return;
        if (event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          onCheckedChange?.(!checked);
        }
      },
      [onKeyDown, disabled, onCheckedChange, checked]
    );

    // Without `label` there is no wrapping <label> to override, so pass
    // through whatever the caller (or a surrounding `<Field>`) gave.
    if (!label) {
      return (
        <input
          ref={innerRef}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheckedChange?.(event.target.checked)}
          onKeyDown={handleKeyDown}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          className={cn(
            'h-4 w-4 shrink-0 rounded-sm border border-input accent-primary shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
          {...props}
        />
      );
    }

    // `label`'s own id, referenced by `aria-labelledby` below, wins over the
    // implicit label-wraps-control name computation — which would otherwise
    // pull `description` into the accessible NAME instead of just the
    // description, since both sit inside the same `<label>` (kept together
    // so clicking either still toggles the checkbox).
    const describedBy = [ariaDescribedBy, description ? descriptionId : null].filter(Boolean).join(' ') || undefined;

    return (
      <label
        htmlFor={inputId}
        className={cn(
          'flex items-start gap-2 leading-snug',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          containerClassName
        )}
      >
        <input
          ref={innerRef}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheckedChange?.(event.target.checked)}
          onKeyDown={handleKeyDown}
          aria-labelledby={ariaLabelledBy ?? labelId}
          aria-describedby={describedBy}
          className={cn(
            'h-4 w-4 shrink-0 rounded-sm border border-input accent-primary shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
          {...props}
        />
        <span className="text-sm">
          <span id={labelId}>{label}</span>
          {description && <span id={descriptionId} className="block text-xs text-muted-foreground">{description}</span>}
        </span>
      </label>
    );
  }
);
Checkbox.displayName = 'Checkbox';
