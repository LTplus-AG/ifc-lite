/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tag chips on a hierarchy MODEL row plus the button that opens the tag
 * editor for that model (#4215). Rendered inside `HierarchyNode`'s model
 * header — which is at its size budget, hence one component call there and
 * everything else here.
 *
 * Every click stops propagation: the row's own click toggles expansion.
 */

import { useState } from 'react';
import { Tag } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelTagChip } from './ModelTagChip';
import { ModelTagEditor } from './ModelTagEditor';

/** Chips drawn inline before the row collapses the rest into "+N". */
const MAX_INLINE_CHIPS = 3;

export function ModelRowTags({ modelId, modelName }: { modelId: string; modelName: string }) {
  const { modelTags, assigned } = useViewerStore(
    useShallow((s) => ({ modelTags: s.modelTags, assigned: s.modelTagAssignments.get(modelId) })),
  );
  const [open, setOpen] = useState(false);
  const ids = assigned ? [...assigned] : [];
  const inline = ids.slice(0, MAX_INLINE_CHIPS);
  const overflow = ids.length - inline.length;

  return (
    <>
      {inline.length > 0 && (
        <span
          className="flex min-w-0 shrink items-center gap-1"
          data-model-row-tags={modelId}
          onClick={(e) => e.stopPropagation()}
        >
          {inline.map((id) => <ModelTagChip key={id} tag={modelTags.get(id)} />)}
          {overflow > 0 && (
            <span className="text-[10px] text-zinc-500" title={ids.slice(MAX_INLINE_CHIPS).map((id) => modelTags.get(id)?.name ?? 'Unknown tag').join(', ')}>
              +{overflow}
            </span>
          )}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpen(true); }}
            aria-label={`Edit tags for model ${modelName}`}
            className="p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            <Tag className="h-3.5 w-3.5 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">Model tags</p>
        </TooltipContent>
      </Tooltip>
      {open && <ModelTagEditor modelIds={[modelId]} modelName={modelName} onClose={() => setOpen(false)} />}
    </>
  );
}
