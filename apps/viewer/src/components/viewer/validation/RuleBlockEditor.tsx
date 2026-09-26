/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleBlockEditor` — chips ↔ selector toggle around `FilterGroupEditor`
 * (or `FoldedGroupEditor` for `foldBetween`) and `SelectorTextEditor`
 * (#5138 plan §6), for one `RuleBlock` (applicability, an `element`
 * requirement's block, or a `groupBy.universe`). `block.authoredAs`
 * remembers which mode it was last edited in, so reopening a saved rule
 * set shows the same surface it was authored with (plan §3).
 *
 * An `ifcType` chip's `exactClass` has no selector spelling —
 * `groupsToSelectorText` (in `@ifc-lite/rules's filter-groups.ts`, NOT touched by
 * this feature) simply cannot render it, so a block that carries one is
 * forced to chips mode here, with a notice, rather than silently losing
 * the flag on a round trip through text.
 */

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { FilterRule } from '@ifc-lite/rules';
import type { FilterGroup } from '@ifc-lite/rules';
import type { RuleBlock } from '@ifc-lite/rules';
import { FilterGroupEditor, type FilterGroupEditorModel, type FilterGroupEditorState } from '../FilterGroupEditor';
import { FoldedGroupEditor } from './FoldedGroupEditor';
import { SelectorTextEditor } from '../SelectorTextEditor';
import { useTranslation } from '@/i18n';

export interface RuleBlockEditorProps {
  block: RuleBlock;
  onChange: (next: RuleBlock) => void;
  allowedKinds?: ReadonlySet<FilterRule['kind']>;
  models: ReadonlyArray<FilterGroupEditorModel>;
  schemaVersion?: string;
  /** True for an `element` requirement's block — see `FoldedGroupEditor`. */
  foldBetween?: boolean;
}

function hasExactClass(groups: readonly FilterGroup[]): boolean {
  return groups.some((g) => g.rules.some((r) => r.kind === 'ifcType' && r.exactClass === true));
}

export function RuleBlockEditor({ block, onChange, allowedKinds, models, schemaVersion, foldBetween }: RuleBlockEditorProps) {
  const { t } = useTranslation();
  const [activeGroup, setActiveGroup] = useState(0);
  const exactClassForced = hasExactClass(block.groups);
  const mode = exactClassForced ? 'chips' : block.authoredAs;

  const handleGroupsChange = (updater: (prev: FilterGroupEditorState) => FilterGroupEditorState) => {
    const next = updater({ groups: block.groups, activeGroup });
    setActiveGroup(next.activeGroup);
    onChange({ groups: next.groups, authoredAs: 'chips' });
  };

  const handleSelectorChange = (groups: FilterGroup[]) => {
    onChange({ groups, authoredAs: 'selector' });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded border border-zinc-200 bg-white p-0.5 text-2xs dark:border-zinc-800 dark:bg-zinc-950">
          <button
            type="button"
            onClick={() => onChange({ ...block, authoredAs: 'chips' })}
            className={`rounded px-2 py-0.5 font-medium transition-colors ${
              mode === 'chips' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('validationEditor.ruleBlockEditor.chipsMode')}
          </button>
          <button
            type="button"
            disabled={exactClassForced}
            onClick={() => !exactClassForced && onChange({ ...block, authoredAs: 'selector' })}
            className={`rounded px-2 py-0.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              mode === 'selector' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('validationEditor.ruleBlockEditor.selectorMode')}
          </button>
        </div>
        {exactClassForced && (
          <span className="inline-flex items-center gap-1 text-2xs text-amber-600 dark:text-amber-500">
            <AlertTriangle className="h-3 w-3" />
            {t('validationEditor.ruleBlockEditor.exactClassNotice')}
          </span>
        )}
      </div>

      {mode === 'chips' &&
        (foldBetween ? (
          <FoldedGroupEditor
            groups={block.groups}
            activeGroup={activeGroup}
            onChange={handleGroupsChange}
            allowedKinds={allowedKinds}
            models={models}
          />
        ) : (
          <FilterGroupEditor
            groups={block.groups}
            activeGroup={activeGroup}
            onChange={handleGroupsChange}
            allowedKinds={allowedKinds}
            schemaVersion={schemaVersion}
            models={models}
          />
        ))}

      {mode === 'selector' && (
        <SelectorTextEditor groups={block.groups} onChange={handleSelectorChange} schemaVersion={schemaVersion} />
      )}
    </div>
  );
}
