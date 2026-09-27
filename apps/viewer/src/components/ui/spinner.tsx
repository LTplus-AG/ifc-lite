/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SVGProps } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

const sizeClasses: Record<SpinnerSize, string> = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
};

export interface SpinnerProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: SpinnerSize;
  /** Announce standalone activity. Omit when nearby text already describes it. */
  label?: string;
}

/** A decorative spinner by default; a named spinner announces its status. */
export function Spinner({ size = 'md', label, className, ...props }: SpinnerProps) {
  const icon = <Loader2 {...props} aria-hidden="true" className={cn('animate-spin', sizeClasses[size], className)} />;
  return label
    ? <output>{icon}<span className="sr-only">{label}</span></output>
    : icon;
}

export interface LoadingStateProps {
  label: string;
  size?: SpinnerSize;
  className?: string;
}

/** A labelled loading block for panels and results. */
export function LoadingState({ label, size = 'lg', className }: LoadingStateProps) {
  return (
    <output className={cn('flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground', className)}>
      <Spinner size={size} />
      <span>{label}</span>
    </output>
  );
}
