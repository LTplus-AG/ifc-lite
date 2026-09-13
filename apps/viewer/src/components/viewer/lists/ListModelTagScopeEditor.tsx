/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list builder's MODEL scope by tag (#4215): which federated models the
 * list runs over, in the same four words search and clash use. Sits inside
 * the builder's Scope section, under the entity-type chips those models are
 * then filtered by. The operator labels are the advanced filter's own
 * (`OP_LABEL`), so "has any of" reads the same in a list as in a search rule.
 *
 * A tag id the scope names but that no longer exists is drawn as an amber
 * "Unknown tag" chip, not hidden — the run refuses such a scope
 * (`lib/lists/model-tag-scope.ts`), so the user must be able to see which
 * chip to remove.
 */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ListModelTagScope } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { MODEL_TAG_OPS, unresolvedModelTagIds, type ModelTagOp } from '@/lib/model-tags/types';
import { describeListModelTagScope } from '@/lib/lists/model-tag-scope';
import { ModelTagChip } from '@/components/viewer/hierarchy/ModelTagChip';
import { OP_LABEL } from '../SearchModal.filter.editors.shared';
import { Chip } from './ListBuilder.parts';

export interface ListModelTagScopeEditorProps {
  value: ListModelTagScope | undefined;
  onChange: (next: ListModelTagScope | undefined) => void;
}

export function ListModelTagScopeEditor({ value, onChange }: ListModelTagScopeEditorProps) {
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
      <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0">Models</span>
        <select
          aria-label="Model tag scope"
          value={value?.op ?? 'all'}
          onChange={(e) => setOp(e.target.value)}
          className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
        >
          <option value="all">all models</option>
          {MODEL_TAG_OPS.map((op) => (
            <option key={op} value={op}>{OP_LABEL[op]}</option>
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
        <p className="text-[10px] text-muted-foreground">Pick at least one tag, or the list runs over no model.</p>
      ) : value && (
        <p className="text-[10px] text-muted-foreground" data-list-model-tag-scope-hint>
          Runs over {describeListModelTagScope(value, tags)}.
        </p>
      )}
      {unresolved.length > 0 && (
        <p role="alert" className="text-[10px] text-amber-700 dark:text-amber-400">
          {unresolved.length === 1 ? 'A tag in this scope' : `${unresolved.length} tags in this scope`} no longer
          exist{unresolved.length === 1 ? 's' : ''}. The list will not run until {unresolved.length === 1 ? 'it is' : 'they are'} removed.
        </p>
      )}
    </div>
  );
}
