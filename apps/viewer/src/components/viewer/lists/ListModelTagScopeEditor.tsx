/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list builder's MODEL scope by tag (#4215): which federated models the
 * list runs over, in the same four words search and clash use. Sits inside
 * the builder's Scope section, under the entity-type chips those models are
 * then filtered by. The operator select uses the shared filter-operator
 * labels; the "Runs over" hint remains a complete sentence per operator.
 *
 * A tag id the scope names but that no longer exists is drawn as an amber
 * "Unknown tag" chip, not hidden — the run refuses such a scope
 * (`lib/lists/model-tag-scope.ts`), so the user must be able to see which
 * chip to remove. `lib/lists/model-tag-scope.ts`'s own `describeListModelTagScope`
 * (used only in that module's thrown-Error text, a distinct fix) stays
 * English-only; this editor's on-screen "Runs over …" sentence is built
 * locally instead (`RUNS_OVER_KEY`), independent of that helper.
 */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ListModelTagScope } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { MODEL_TAG_OPS, unresolvedModelTagIds, type ModelTagOp } from '@ifc-lite/rules';
import { ModelTagChip } from '@/components/viewer/hierarchy/ModelTagChip';
import { Chip } from './ListBuilder.parts';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n/en';
import { FILTER_OPERATOR_LABEL_KEYS } from '@/lib/filter-operator-labels';

/** Translation key for the "Runs over …" sentence, one per operator so each
 *  is a complete, independently-translatable message (not an English
 *  description substituted into a generic wrapper). */
const RUNS_OVER_KEY: Record<Exclude<ModelTagOp, 'untagged'>, TranslationKey> = {
  hasAny: 'lists.modelTagScope.runsOverHasAny',
  hasAll: 'lists.modelTagScope.runsOverHasAll',
  hasNone: 'lists.modelTagScope.runsOverHasNone',
};

export interface ListModelTagScopeEditorProps {
  value: ListModelTagScope | undefined;
  onChange: (next: ListModelTagScope | undefined) => void;
}

export function ListModelTagScopeEditor({ value, onChange }: ListModelTagScopeEditorProps) {
  const { t } = useTranslation();
  const { tags, assignments, models } = useViewerStore(
    useShallow((s) => ({ tags: s.modelTags, assignments: s.modelTagAssignments, models: s.models })),
  );
  const options = useMemo(() => [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)), [tags]);
  const countFor = (tagId: string) => [...models.keys()].filter((m) => assignments.get(m)?.has(tagId)).length;
  const unresolved = value ? unresolvedModelTagIds(value, new Set(tags.keys())) : [];
  const setOp = (op: string) => {
    if (op === 'all') return onChange(undefined);
    onChange({ op: op as ModelTagOp, tagIds: value?.tagIds ?? [] });
  };
  const toggleTag = (id: string) => {
    if (!value) return;
    const tagIds = value.tagIds.includes(id) ? value.tagIds.filter((t) => t !== id) : [...value.tagIds, id];
    onChange({ ...value, tagIds });
  };

  // Nothing to scope by: no tag exists and the list is not already scoped.
  if (options.length === 0 && !value) return null;

  return (
    <div className="mt-3 space-y-1.5" data-list-model-tag-scope>
      <label className="flex items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0">{t('lists.modelTagScope.models')}</span>
        <select
          aria-label={t('lists.modelTagScope.selectAriaLabel')}
          value={value?.op ?? 'all'}
          onChange={(e) => setOp(e.target.value)}
          className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
        >
          <option value="all">{t('lists.modelTagScope.allModels')}</option>
          {MODEL_TAG_OPS.map((op) => (
            <option key={op} value={op}>{t(FILTER_OPERATOR_LABEL_KEYS[op])}</option>
          ))}
        </select>
      </label>
      {value && value.op !== 'untagged' && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((tag) => (
            <Chip key={tag.id} selected={value.tagIds.includes(tag.id)} onClick={() => toggleTag(tag.id)} trailing={countFor(tag.id)}>
              {tag.name}
            </Chip>
          ))}
          {unresolved.map((id) => (
            <ModelTagChip key={id} tag={undefined} unresolved onRemove={() => toggleTag(id)} />
          ))}
        </div>
      )}
      {value && value.op !== 'untagged' && value.tagIds.length === 0 ? (
        <p className="text-2xs text-muted-foreground">{t('lists.modelTagScope.pickAtLeastOneTag')}</p>
      ) : value && (
        <p className="text-2xs text-muted-foreground" data-list-model-tag-scope-hint>
          {value.op === 'untagged'
            ? t('lists.modelTagScope.runsOverUntagged')
            : t(RUNS_OVER_KEY[value.op], {
                names: value.tagIds.map((id) => tags.get(id)?.name ?? t('lists.modelTagScope.unknownTagName')).join(', ') || '—',
              })}
        </p>
      )}
      {unresolved.length > 0 && (
        <p role="alert" className="text-2xs text-amber-700 dark:text-amber-400">
          {t('lists.modelTagScope.unresolvedTagsWarning', { count: unresolved.length })}
        </p>
      )}
    </div>
  );
}
