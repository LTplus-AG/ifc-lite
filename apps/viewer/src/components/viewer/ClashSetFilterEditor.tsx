/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One side of a clash rule, edited with the shared OR-of-groups UI (#5898). */
import { useCallback, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { emptyFilterGroup } from '@ifc-lite/rules';
import {
  activeClashSetFilter,
  unreadableRuleCount,
  type ClashSetFilter,
} from '@/lib/clash/set-filter';
import { FilterGroupEditor, type FilterGroupEditorState } from './FilterGroupEditor';

export interface ClashSetFilterEditorProps {
  label: string;
  filter: ClashSetFilter | undefined;
  /** A functional update keeps consecutive rule/group edits in order. */
  onChange: (updater: (previous: ClashSetFilter | undefined) => ClashSetFilter | undefined) => void;
}

export function ClashSetFilterEditor({ label, filter, onChange }: ClashSetFilterEditorProps) {
  const { t } = useTranslation();
  const models = useViewerStore((state) => state.models);
  const [activeGroup, setActiveGroup] = useState(0);
  const groups = filter ?? [emptyFilterGroup()];
  const editorState = useRef<FilterGroupEditorState>({ groups, activeGroup });
  editorState.current = { groups, activeGroup };
  const unreadable = unreadableRuleCount(filter);

  const commit = useCallback((updater: (previous: FilterGroupEditorState) => FilterGroupEditorState) => {
    // FilterGroupEditor updates its selected tab and groups together. The
    // parent owns the saved groups, so apply the same pure updater to its
    // latest draft rather than closing over a previous render's filter.
    const previousState = editorState.current;
    const preview = updater(previousState);
    // Keep consecutive clicks ordered even when React batches them before a
    // render (e.g. add two groups, then add a rule to the newest group).
    editorState.current = preview;
    setActiveGroup(preview.activeGroup);
    onChange((previous) => {
      const previousGroups = previous ?? [emptyFilterGroup()];
      const next = updater({ groups: previousGroups, activeGroup: previousState.activeGroup });
      if (next.groups === previousGroups) return previous; // Selecting a tab is not an edit.
      // As before #5898, an explicit edit discards unreadable entries only
      // after the warning above. Retaining them would leave the run refused
      // even though the user just repaired the visible filter.
      const editable = next.groups.map((group) => ({ combinator: group.combinator, rules: group.rules }));
      // Clearing the final rule means selector fallback, never empty members.
      return activeClashSetFilter(editable) ? editable : undefined;
    });
  }, [onChange]);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {filter && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-2xs text-muted-foreground"
            onClick={() => onChange(() => undefined)}
            title={t('clashTools.setFilter.clearTooltip')}
          >
            <Trash2 className="h-3 w-3" /> {t('clashTools.setFilter.clearLabel')}
          </Button>
        )}
      </div>

      {unreadable > 0 && (
        <p role="alert" data-clash-filter-unreadable className="text-2xs leading-snug text-amber-700 dark:text-amber-400">
          {t('clashTools.setFilter.unreadableWarning', { count: unreadable })}
        </p>
      )}

      <FilterGroupEditor
        groups={groups}
        activeGroup={activeGroup}
        onChange={commit}
        models={[...models.values()].map((model) => ({
          id: model.id,
          name: model.name,
          sourceFingerprint: model.sourceFingerprint,
        }))}
      />

      {filter && (
        <p className="text-2xs text-muted-foreground leading-snug">
          {t('clashTools.setFilter.definedByFilter', { label: label.toLowerCase() })}
        </p>
      )}
    </div>
  );
}
