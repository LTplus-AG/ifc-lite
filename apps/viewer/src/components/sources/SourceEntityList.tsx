/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from 'react';
import { Loader2 } from 'lucide-react';

interface SourceEntityListProps<T extends { id: string; name: string }> {
  items: readonly T[];
  loading: boolean;
  icon: ComponentType<{ className?: string }>;
  emptyLabel: string;
  onSelect: (item: T) => void;
}

/** Shared list rendering for the 'projects' and 'file-areas' browsing steps — a flat, selectable list of named entities. */
export function SourceEntityList<T extends { id: string; name: string }>({
  items,
  loading,
  icon: Icon,
  emptyLabel,
  onSelect,
}: SourceEntityListProps<T>) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ul className="divide-y">
      {items.map((item) => (
        <li key={item.id}>
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
            onClick={() => onSelect(item)}
          >
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{item.name}</span>
          </button>
        </li>
      ))}
      {items.length === 0 && (
        <li className="px-3 py-4 text-center text-sm text-muted-foreground">{emptyLabel}</li>
      )}
    </ul>
  );
}
