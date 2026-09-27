/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleSetEditor` — a `RuleSetFile`'s list of `InformationRule`s (#5138
 * plan §6): add / remove / rename (the name field on each `RuleCard`),
 * the model-target picker, and per-rule editing via `RuleCard`. Reorder is
 * explicitly NOT required by the plan.
 *
 * Presentational/controlled only, like every file in this PR — no panel
 * registry entry, no store slice (PR 4 owns the panel, PR 3 the engine).
 * `file`/`onChange` is the whole contract; a caller (the eventual
 * `ValidationPanel`) owns persistence.
 */

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InformationRule, RuleSetFile } from '@ifc-lite/rules';
import { RuleCard } from './RuleSetEditor.ruleCard';
import { RuleModelPicker, type RuleModelPickerModel } from './RuleModelPicker';
import { useTranslation } from '@/i18n';

function blankRule(): InformationRule {
  return {
    id: crypto.randomUUID(),
    name: '',
    applicability: { groups: [{ rules: [], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: { kind: 'element', block: { groups: [{ rules: [], combinator: 'AND' }], authoredAs: 'chips' } },
  };
}

export interface RuleSetEditorProps {
  file: RuleSetFile;
  onChange: (next: RuleSetFile) => void;
  models: ReadonlyArray<RuleModelPickerModel>;
}

export function RuleSetEditor({ file, onChange, models }: RuleSetEditorProps) {
  const { t } = useTranslation();

  const addRule = () => onChange({ ...file, rules: [...file.rules, blankRule()] });
  const updateRule = (index: number, next: InformationRule) =>
    onChange({ ...file, rules: file.rules.map((r, i) => (i === index ? next : r)) });
  const removeRule = (index: number) =>
    onChange({ ...file, rules: file.rules.filter((_, i) => i !== index) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Input
          value={file.name}
          onChange={(e) => onChange({ ...file, name: e.target.value })}
          placeholder={t('validationEditor.ruleSetEditor.namePlaceholder')}
          aria-label={t('validationEditor.ruleSetEditor.nameAriaLabel')}
          className="h-8 text-sm font-medium"
        />
        <Input
          value={file.description ?? ''}
          onChange={(e) => onChange({ ...file, description: e.target.value || undefined })}
          placeholder={t('validationEditor.ruleSetEditor.descriptionPlaceholder')}
          aria-label={t('validationEditor.ruleSetEditor.descriptionAriaLabel')}
          className="h-7 text-xs"
        />
      </div>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('validationEditor.ruleSetEditor.targets')}
        </h3>
        <RuleModelPicker
          models={models}
          value={file.targets?.modelFingerprints}
          onChange={(modelFingerprints) =>
            onChange({
              ...file,
              targets: cleanTargets({ ...file.targets, modelFingerprints }),
            })
          }
        />
      </section>

      <div className="flex flex-col gap-3">
        {file.rules.length === 0 && (
          <p className="rounded border border-dashed border-zinc-300 bg-zinc-50 px-3 py-4 text-center text-xs italic text-muted-foreground dark:border-zinc-800 dark:bg-zinc-900/30">
            {t('validationEditor.ruleSetEditor.emptyRulesHint')}
          </p>
        )}
        {file.rules.map((rule, i) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            onChange={(next) => updateRule(i, next)}
            onRemove={() => removeRule(i)}
            models={models}
          />
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={addRule} className="h-8 w-fit gap-1 text-xs">
          <Plus className="h-3.5 w-3.5" /> {t('validationEditor.ruleSetEditor.addRule')}
        </Button>
      </div>
    </div>
  );
}

function cleanTargets(t: { modelFingerprints?: string[]; modelTagIds?: string[] }): RuleSetFile['targets'] {
  if (t.modelFingerprints === undefined && t.modelTagIds === undefined) return undefined;
  return t;
}
