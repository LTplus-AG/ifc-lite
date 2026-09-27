/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center p-6 text-center', className)}>
      <div aria-hidden="true" className="mb-4 flex size-16 items-center justify-center border-2 border-dashed border-zinc-300 bg-zinc-100 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500">
        {icon}
      </div>
      <p className="mb-2 font-bold uppercase text-zinc-900 dark:text-zinc-100">{title}</p>
      {description && <p className="max-w-[220px] text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
