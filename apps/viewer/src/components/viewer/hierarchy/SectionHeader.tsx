/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react';

export interface SectionHeaderProps {
  icon: React.ElementType;
  title: string;
  count?: number;
  /** Trailing actions (sort, floorplan) that belong to this section. */
  actions?: ReactNode;
}

/** The tree's section header: one sentence-case voice, a muted count right
 *  after the title, and the section's own actions at the trailing edge
 *  (#8802), so no extra strip exists just to host a button. */
export function SectionHeader({ icon: IconComponent, title, count, actions }: SectionHeaderProps) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1.5">
      <IconComponent className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-xs font-semibold text-foreground">
        {title}
      </span>
      {count !== undefined && (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}
