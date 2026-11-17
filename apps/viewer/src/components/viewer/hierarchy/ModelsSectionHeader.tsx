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
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
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

const CHIP_CLASS = 'h-5 rounded-none px-1.5 text-2xs uppercase tracking-wider';

export function ModelsSectionHeader({ count }: { count: number }) {
  const { t, locale } = useTranslation();
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
      <SectionHeader icon={FileBox} title={t('hierarchy.modelsSection.title')} count={count} />
      {(inUse.length > 0 || filterActive || view.groupByTag) && (
        <div className="flex flex-wrap items-center gap-1 px-2 py-1 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950" data-model-tag-controls>
          <Button
            variant="toggle"
            size="sm"
            aria-pressed={view.groupByTag}
            className={CHIP_CLASS}
            onClick={() => setModelTagView({ groupByTag: !view.groupByTag })}
            title={t('hierarchy.modelsSection.byTagTooltip')}
          >
            <Tag className="mr-1 h-3 w-3" /> {t('hierarchy.modelsSection.byTag')}
          </Button>
          <span className="mx-1 h-3 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden />
          {chips.map((tag) => {
            const active = view.filterTagIds.includes(tag.id);
            return (
              <Button
                key={tag.id}
                variant="toggle"
                size="sm"
                aria-pressed={active}
                aria-label={t(active
                  ? 'hierarchy.modelsSection.tagFilterActiveAriaLabel'
                  : 'hierarchy.modelsSection.tagFilterInactiveAriaLabel', { name: tag.name })}
                className={CHIP_CLASS}
                onClick={() => toggleTag(tag.id)}
                title={t('hierarchy.modelsSection.tagFilterTooltip', { name: tag.name })}
              >
                {tag.name}
              </Button>
            );
          })}
          <Button
            variant="toggle"
            size="sm"
            aria-pressed={view.filterUntagged}
            aria-label={t(view.filterUntagged
              ? 'hierarchy.modelsSection.untaggedFilterActiveAriaLabel'
              : 'hierarchy.modelsSection.untaggedFilterInactiveAriaLabel')}
            className={CHIP_CLASS}
            onClick={() => setModelTagView({ filterUntagged: !view.filterUntagged })}
            title={t('hierarchy.modelsSection.untaggedFilterTooltip')}
          >
            {t('hierarchy.modelsSection.untagged')}
          </Button>
          {filterActive && matching && (
            <>
              <Button
                variant="outline"
                size="sm"
                className={`${CHIP_CLASS} text-muted-foreground`}
                onClick={() => isolateModels(matching)}
                title={t('hierarchy.modelsSection.isolateMatchingTooltip')}
              >
                <Eye className="mr-1 h-3 w-3" /> {t('hierarchy.modelsSection.isolateMatching')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={`${CHIP_CLASS} text-muted-foreground`}
                aria-label={t('hierarchy.modelsSection.clearFilterAriaLabel')}
                onClick={() => setModelTagView({ filterTagIds: [], filterUntagged: false })}
              >
                {t('hierarchy.modelsSection.clear')}
              </Button>
              <span className="ml-auto text-2xs font-mono text-zinc-500" data-model-tag-filter-count>
                {t('hierarchy.modelsSection.matchingCount', { matching: formatLocaleNumber(locale, matching.length), total: formatLocaleNumber(locale, models.size) })}
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}
