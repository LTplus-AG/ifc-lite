/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One model tag as a compact chip (#4215) — the same drawing on a hierarchy
 * model row, in the tag editor, and in a `modelTag` filter rule, so a tag
 * looks like itself wherever it appears.
 */

import { cn } from '@/lib/utils';
import type { ModelTag } from '@/lib/model-tags/types';

export interface ModelTagChipProps {
  /** Undefined when the id has no definition any more (a deleted tag). */
  tag: ModelTag | undefined;
  /** Draw as a broken reference. Implied by `tag === undefined`. */
  unresolved?: boolean;
  onRemove?: () => void;
  className?: string;
}

export function ModelTagChip({ tag, unresolved, onRemove, className }: ModelTagChipProps) {
  const broken = unresolved || !tag;
  const label = tag?.name ?? 'Unknown tag';
  return (
    <span
      data-model-tag-chip={tag?.id ?? ''}
      data-unresolved={broken ? 'true' : undefined}
      title={broken ? 'This tag no longer exists' : label}
      className={cn(
        'inline-flex max-w-[9rem] items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-tight',
        broken
          ? 'border border-dashed border-amber-500 text-amber-700 dark:text-amber-400'
          : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
        className,
      )}
      style={!broken && tag?.color ? { borderLeft: `3px solid ${tag.color}` } : undefined}
    >
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${label}`}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      )}
    </span>
  );
}
