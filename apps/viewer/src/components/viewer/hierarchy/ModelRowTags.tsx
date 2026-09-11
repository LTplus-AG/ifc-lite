/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tag chips on a hierarchy MODEL row plus the button that opens the tag
 * editor for that model (#4215). Rendered inside `HierarchyNode`'s model
 * header — which is at its size budget, hence one component call there and
 * everything else here, including the row height the chips line needs.
 *
 * Every click stops propagation: the row's own click toggles expansion.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Tag } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TreeNode } from './types';
import { ModelTagChip } from './ModelTagChip';
import { ModelTagEditor } from './ModelTagEditor';

/** Chips drawn before the strip collapses the rest into "+N". */
const MAX_INLINE_CHIPS = 3;

/**
 * Row heights the Models section's virtualizer uses (`useModelRowSize`).
 * The name, the element count and the row actions already fill a model row
 * at the panel's default ~260px width — there is no room beside them — so a
 * tagged model's row is taller and the chips sit on a second line under
 * the name, absolutely placed against the virtual row so the first line's
 * flex layout is untouched.
 */
export const MODEL_ROW_HEIGHT = 36;
export const TAGGED_MODEL_ROW_HEIGHT = 54;

/** `estimateSize` for the Models section: tagged model rows get the chips line. Re-measures when tags change. */
export function useModelRowSize(nodes: readonly TreeNode[], remeasure: () => void): (index: number) => number {
  const assignments = useViewerStore((s) => s.modelTagAssignments);
  const size = useCallback(
    (index: number) => {
      const node = nodes[index];
      const tagged = node?.type === 'model-header' && node.id.startsWith('model-') && (assignments.get(node.modelIds[0])?.size ?? 0) > 0;
      return tagged ? TAGGED_MODEL_ROW_HEIGHT : MODEL_ROW_HEIGHT;
    },
    [nodes, assignments],
  );
  // tanstack-virtual memoises measurements on its own cache version, not on
  // `estimateSize`'s identity; a changed size function must clear that cache.
  // The caller's closure is read through a ref so only `size` retriggers.
  const remeasureRef = useRef(remeasure);
  remeasureRef.current = remeasure;
  useEffect(() => { remeasureRef.current(); }, [size]);
  return size;
}

const STRIP_CLASS = 'absolute bottom-1 left-[54px] right-2 flex min-w-0 items-center gap-1 overflow-hidden';

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
          className={STRIP_CLASS}
          data-model-row-tags={modelId}
          title={ids.map((id) => modelTags.get(id)?.name ?? 'Unknown tag').join(', ')}
          onClick={(e) => e.stopPropagation()}
        >
          {inline.map((id) => <ModelTagChip key={id} tag={modelTags.get(id)} className="min-w-0 shrink" />)}
          {overflow > 0 && <span className="shrink-0 text-[10px] text-zinc-500">+{overflow}</span>}
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
