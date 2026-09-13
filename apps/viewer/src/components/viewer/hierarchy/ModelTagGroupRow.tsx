/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A `model-tag-group` header row in the Models section's "By tag" view
 * (#4215): the tag's name, how many DISTINCT models carry it, and one eye
 * that shows or hides all of them in a single store write.
 *
 * Rendered by `HierarchyNode` for that node type; everything the row needs
 * beyond the node is read from the store here, so the (size-capped)
 * `HierarchyNode` gains one line.
 */

import { Eye, EyeOff, Tag } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { UNTAGGED_GROUP_ID } from './modelTagView';
import type { TreeNode } from './types';

export function ModelTagGroupRow({ node, virtualRow }: { node: TreeNode; virtualRow: { size: number; start: number } }) {
  const { models, setModelsVisibility, tag } = useViewerStore(
    useShallow((s) => ({
      models: s.models,
      setModelsVisibility: s.setModelsVisibility,
      tag: s.modelTags.get(node.id.slice('model-tag-group:'.length)),
    })),
  );
  const members = node.modelIds;
  const visibleCount = members.filter((id) => models.get(id)?.visible).length;
  const allVisible = members.length > 0 && visibleCount === members.length;
  const isUntagged = node.id === `model-tag-group:${UNTAGGED_GROUP_ID}`;

  return (
    <div
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 border-l-4 border-transparent group',
          'bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200',
          members.length > 0 && visibleCount === 0 && 'opacity-50',
        )}
        data-model-tag-group={isUntagged ? UNTAGGED_GROUP_ID : tag?.id ?? ''}
      >
        <Tag className="h-3.5 w-3.5 shrink-0 text-zinc-400" style={tag?.color ? { color: tag.color } : undefined} />
        <span className={cn('flex-1 truncate text-xs font-semibold', isUntagged && 'italic')}>{node.name}</span>
        <span
          className="text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-500 dark:text-zinc-400"
          title={`${members.length} model${members.length === 1 ? '' : 's'}`}
        >
          {members.length}
        </span>
        {members.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setModelsVisibility(members, !allVisible); }}
                aria-label={allVisible ? `Hide models tagged ${node.name}` : `Show models tagged ${node.name}`}
                className="p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
              >
                {allVisible ? (
                  <Eye className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{allVisible ? 'Hide these models' : 'Show these models'}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
