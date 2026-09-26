/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleModelPicker` — which loaded models a rule set targets, written as
 * `RuleSetTargets.modelFingerprints` (#5138 plan §3: "Never a local model
 * id" — a persisted rule set survives a reload, where runtime ids are
 * freshly minted). "All models" is the default: an empty/absent list, per
 * `rule-set.ts`'s own doc.
 *
 * A fingerprint the file names that is NOT among the currently loaded
 * `models` renders as "not loaded" rather than silently vanishing from the
 * list — the author needs to see it is still selected before saving again
 * drops it for good.
 */

import { Check } from 'lucide-react';
import { useTranslation } from '@/i18n';

export interface RuleModelPickerModel {
  id: string;
  name: string;
  sourceFingerprint?: string;
}

export interface RuleModelPickerProps {
  models: ReadonlyArray<RuleModelPickerModel>;
  /** `undefined`/`[]` = all models. */
  value: readonly string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}

export function RuleModelPicker({ models, value, onChange }: RuleModelPickerProps) {
  const { t } = useTranslation();
  const selected = new Set(value ?? []);
  const allModels = selected.size === 0;

  const loadedFingerprints = new Set(
    models.map((m) => m.sourceFingerprint).filter((f): f is string => f !== undefined),
  );
  const notLoaded = [...selected].filter((fp) => !loadedFingerprints.has(fp));

  const toggle = (fingerprint: string) => {
    const next = new Set(selected);
    if (next.has(fingerprint)) next.delete(fingerprint);
    else next.add(fingerprint);
    onChange(next.size === 0 ? undefined : [...next]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onChange(undefined)}
          aria-pressed={allModels}
          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
            allModels
              ? 'border-primary bg-primary/10 font-medium text-foreground'
              : 'border-zinc-200 text-muted-foreground hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800'
          }`}
        >
          {allModels && <Check className="h-3 w-3" />}
          {t('validationEditor.modelPicker.allModels')}
        </button>
        {models.map((m) => {
          const fp = m.sourceFingerprint;
          const isSelected = fp !== undefined && selected.has(fp);
          return (
            <button
              key={m.id}
              type="button"
              disabled={fp === undefined}
              onClick={() => fp !== undefined && toggle(fp)}
              aria-pressed={isSelected}
              title={fp === undefined ? t('validationEditor.modelPicker.noFingerprintTitle') : undefined}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                isSelected
                  ? 'border-primary bg-primary/10 font-medium text-foreground'
                  : 'border-zinc-200 text-muted-foreground hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800'
              }`}
            >
              {isSelected && <Check className="h-3 w-3" />}
              {m.name}
            </button>
          );
        })}
      </div>
      {notLoaded.length > 0 && (
        <p className="text-2xs text-amber-600 dark:text-amber-500">
          {t('validationEditor.modelPicker.notLoaded', { count: notLoaded.length })}
        </p>
      )}
    </div>
  );
}
