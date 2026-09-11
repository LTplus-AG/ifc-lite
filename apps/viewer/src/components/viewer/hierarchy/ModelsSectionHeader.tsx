/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Models section of the federated hierarchy (#4215): its header, the tag
 * controls under it, and the hook that applies the same view to the rows.
 * Both halves read ONE store field (`modelTagView`), so the chips and the
 * rows cannot disagree about what is filtered or grouped.
 *
 * Controls (once some loaded model carries a tag — a federation with no tags
 * looks exactly as it did — and for as long as a filter or the grouping is
 * set, so the control that clears it can never vanish with the last tagged
 * model and strand an empty section):
 *  - **By tag** — group the rows, with an explicit Untagged group;
 *  - one chip per tag in use, plus **Untagged** — a ROW filter: it lists
 *    fewer models and hides nothing in the viewport;
 *  - **Isolate matching models** — the explicit viewport action: show the
 *    listed models, hide the rest, in one store write.
 */

import { useMemo } from 'react';
import { Eye, FileBox, Tag } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SectionHeader } from './SectionHeader';
import type { TreeNode } from './types';
import { applyModelTagView, isModelTagFilterActive, modelIdsMatchingTagView } from './modelTagView';

/** The Models-section rows under the current tag view. */
export function useModelTagView(nodes: TreeNode[]): TreeNode[] {
  const { view, tags, assignments } = useViewerStore(
    useShallow((s) => ({ view: s.modelTagView, tags: s.modelTags, assignments: s.modelTagAssignments })),
  );
  return useMemo(() => applyModelTagView(nodes, view, tags, assignments), [nodes, view, tags, assignments]);
}

const chipClass = (active: boolean) =>
  cn(
    'h-5 rounded-none px-1.5 text-[10px] uppercase tracking-wider',
    !active && 'text-zinc-600 dark:text-zinc-400',
  );

export function ModelsSectionHeader({ count }: { count: number }) {
  const { view, tags, assignments, models, setModelTagView, isolateModels } = useViewerStore(
    useShallow((s) => ({
      view: s.modelTagView,
      tags: s.modelTags,
      assignments: s.modelTagAssignments,
      models: s.models,
      setModelTagView: s.setModelTagView,
      isolateModels: s.isolateModels,
    })),
  );

  // Tags some LOADED model carries, by name — not the whole browser vocabulary.
  const inUse = useMemo(() => {
    const ids = new Set<string>();
    for (const modelId of models.keys()) for (const id of assignments.get(modelId) ?? []) if (tags.has(id)) ids.add(id);
    return [...ids].map((id) => tags.get(id)!).sort((a, b) => a.name.localeCompare(b.name));
  }, [models, assignments, tags]);

  const filterActive = isModelTagFilterActive(view);
  const matching = useMemo(
    () => (filterActive ? modelIdsMatchingTagView(models.keys(), view, assignments) : null),
    [filterActive, models, view, assignments],
  );
  // A filter naming a tag no loaded model carries any more (the user just
  // unassigned it) keeps its chip, so the user can see what is filtering.
  const strayFilterTags = useMemo(
    () => view.filterTagIds.filter((id) => tags.has(id) && !inUse.some((t) => t.id === id)).map((id) => tags.get(id)!),
    [view.filterTagIds, tags, inUse],
  );
  const chips = strayFilterTags.length > 0 ? [...inUse, ...strayFilterTags].sort((a, b) => a.name.localeCompare(b.name)) : inUse;

  const toggleTag = (id: string) =>
    setModelTagView({
      filterTagIds: view.filterTagIds.includes(id) ? view.filterTagIds.filter((t) => t !== id) : [...view.filterTagIds, id],
    });

  return (
    <>
      <SectionHeader icon={FileBox} title="Models" count={count} />
      {(inUse.length > 0 || filterActive || view.groupByTag) && (
        <div className="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950" data-model-tag-controls>
          <Button
            variant={view.groupByTag ? 'default' : 'outline'}
            size="sm"
            aria-pressed={view.groupByTag}
            className={chipClass(view.groupByTag)}
            onClick={() => setModelTagView({ groupByTag: !view.groupByTag })}
            title="Group the model rows by tag, with an Untagged group"
          >
            <Tag className="mr-1 h-3 w-3" /> By tag
          </Button>
          <span className="mx-1 h-3 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden />
          {chips.map((tag) => {
            const active = view.filterTagIds.includes(tag.id);
            return (
              <Button
                key={tag.id}
                variant={active ? 'default' : 'outline'}
                size="sm"
                aria-pressed={active}
                aria-label={`${active ? 'Stop listing' : 'List'} models tagged ${tag.name}`}
                className={chipClass(active)}
                onClick={() => toggleTag(tag.id)}
                title={`List the models tagged ${tag.name} — this filters the rows, it does not hide models`}
              >
                {tag.name}
              </Button>
            );
          })}
          <Button
            variant={view.filterUntagged ? 'default' : 'outline'}
            size="sm"
            aria-pressed={view.filterUntagged}
            aria-label={`${view.filterUntagged ? 'Stop listing' : 'List'} untagged models`}
            className={chipClass(view.filterUntagged)}
            onClick={() => setModelTagView({ filterUntagged: !view.filterUntagged })}
            title="List the models that carry no tag"
          >
            Untagged
          </Button>
          {filterActive && matching && (
            <>
              <Button
                variant="outline"
                size="sm"
                className={chipClass(false)}
                onClick={() => isolateModels(matching)}
                title="Show the listed models and hide every other model in the viewport"
              >
                <Eye className="mr-1 h-3 w-3" /> Isolate matching models
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={chipClass(false)}
                aria-label="Clear model tag filter"
                onClick={() => setModelTagView({ filterTagIds: [], filterUntagged: false })}
              >
                Clear
              </Button>
              <span className="ml-auto text-[10px] font-mono text-zinc-500" data-model-tag-filter-count>
                {matching.length} of {models.size}
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
