/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils';

export type ProgressRingSize = 'xs' | 'sm' | 'md';

const sizeClasses: Record<ProgressRingSize, string> = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
};

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ProgressRingProps {
  /** Percent complete, 0-100. Out-of-range values are clamped. */
  value: number;
  /** Accessible name: what is progressing. The value is announced separately. */
  label: string;
  size?: ProgressRingSize;
  className?: string;
}

/**
 * A determinate circular progress indicator: the round sibling of
 * `Progress`, sized to sit inline with an icon. Use `Spinner` instead when
 * the total is unknown; a ring that cannot fill is a promise it cannot keep.
 */
export function ProgressRing({ value, label, size = 'sm', className }: ProgressRingProps) {
  const percent = Math.round(Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)));
  return (
    <svg
      // A native <progress> renders as a bar and cannot be drawn as a ring;
      // this is the WAI-ARIA progressbar pattern, the same role Radix gives
      // the bar in `progress.tsx`.
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      viewBox="0 0 18 18"
      className={cn('shrink-0 -rotate-90', sizeClasses[size], className)}
    >
      <circle cx="9" cy="9" r={RADIUS} fill="none" strokeWidth="2.5" className="stroke-primary/20" />
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
        className="stroke-primary transition-[stroke-dashoffset] duration-100"
      />
    </svg>
  );
}
