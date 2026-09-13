/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `modelTag` chip editor (#4215) — shared by the search filter builder and
 * the clash set filter editor through `RuleRow`.
 *
 * A rule stores tag IDS, so this renders NAMES looked up in `tags` and never
 * the raw ids the generic `SetRuleEditor` would print. An id with no
 * definition behind it (the tag was deleted) is drawn as an amber
 * "Unknown tag" chip rather than hidden: the evaluator treats such a rule as
 * matching nothing, and the clash resolver refuses it outright, so the
 * user must be able to see which chip is the problem and remove it.
 */

import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Rule, type FilterRule, type ModelTagRule } from '@/lib/search/filter-rules';
import { MODEL_TAG_OPS, unresolvedModelTagIds, type ModelTag, type ModelTagOp } from '@/lib/model-tags/types';
import { OpDropdown } from './SearchModal.filter.editors.shared';
import { ModelTagChip } from './hierarchy/ModelTagChip';

export interface ModelTagRuleEditorProps {
  rule: ModelTagRule;
  tags: ReadonlyMap<string, ModelTag>;
  onChange: (next: FilterRule) => void;
}

export function ModelTagRuleEditor({ rule, tags, onChange }: ModelTagRuleEditorProps) {
  const commit = (op: ModelTagOp, tagIds: string[]) => onChange(Rule.modelTag(op, tagIds));
  const toggle = (id: string) =>
    commit(rule.op, rule.tagIds.includes(id) ? rule.tagIds.filter((t) => t !== id) : [...rule.tagIds, id]);
  const unresolved = new Set(unresolvedModelTagIds(rule, new Set(tags.keys())));
  const options = [...tags.values()];

  return (
    <>
      <OpDropdown ops={MODEL_TAG_OPS} value={rule.op} onChange={(next) => commit(next, rule.tagIds)} />
      {rule.op !== 'untagged' && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs font-mono" aria-label="Pick model tags">
              {rule.tagIds.length === 0 ? 'Pick tags…' : `${rule.tagIds.length} selected`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {options.length === 0 && (
              <DropdownMenuItem disabled className="text-muted-foreground italic">
                No model tags yet — tag a model in the hierarchy first.
              </DropdownMenuItem>
            )}
            {options.map((tag) => (
              <DropdownMenuItem
                key={tag.id}
                onSelect={(e) => { e.preventDefault(); toggle(tag.id); }}
                className="font-mono"
              >
                <span className="mr-2 inline-block w-3 text-center">{rule.tagIds.includes(tag.id) ? '✓' : ''}</span>
                {tag.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {rule.op !== 'untagged' && rule.tagIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {rule.tagIds.map((id) => (
            <ModelTagChip
              key={id}
              tag={tags.get(id)}
              unresolved={unresolved.has(id)}
              onRemove={() => toggle(id)}
            />
          ))}
        </div>
      )}
      {unresolved.size > 0 && (
        <span role="alert" className="text-[10px] text-amber-600 dark:text-amber-400">
          {unresolved.size === 1 ? 'A tag in this rule' : `${unresolved.size} tags in this rule`} no longer
          exist{unresolved.size === 1 ? 's' : ''} — the rule matches nothing until it is fixed.
        </span>
      )}
    </>
  );
}
