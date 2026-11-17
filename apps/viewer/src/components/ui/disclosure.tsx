/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The summary row of a native `<details>` disclosure, with the viewer's
 * chevron instead of the browser's ▶ marker (#8802 R3a), so a disclosure
 * reads like every other collapsible row. The `<details>` must carry
 * `DISCLOSURE_GROUP` for the chevron to turn when it opens.
 */

import type { HTMLAttributes } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DISCLOSURE_GROUP = 'group/disclosure';

export function DisclosureSummary({ className, children, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <summary
      className={cn('flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden', className)}
      {...rest}
    >
      <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/disclosure:rotate-90" />
      <span className="min-w-0">{children}</span>
    </summary>
  );
}
