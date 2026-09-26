/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HeightStrategyPanel — sub-panel shown when the Generate dialog's Height
 * strategy is selected. Exposes slice-height + subgroup mode. Extracted so
 * the parent dialog file focuses on strategy selection, primary fields,
 * and the preview.
 */

import { Ruler } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { GenerateScheduleOptions } from './generate-schedule';

export interface HeightStrategyPanelProps {
  heightTolerance: number;
  elementZSubgroup: GenerateScheduleOptions['elementZSubgroup'];
  onHeightToleranceChange: (next: number) => void;
  onSubgroupChange: (next: GenerateScheduleOptions['elementZSubgroup']) => void;
}

export function HeightStrategyPanel({
  heightTolerance,
  elementZSubgroup,
  onHeightToleranceChange,
  onSubgroupChange,
}: HeightStrategyPanelProps) {
  const { t, locale } = useTranslation();
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 grid gap-3">
      <div className="flex items-center gap-2">
        <Ruler className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">{t('schedule.heightStrategy.title')}</span>
        <span className="ml-auto text-2xs text-muted-foreground">
          {t('schedule.heightStrategy.usesGeometry')}
        </span>
      </div>

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="gen-tol" className="text-xs">{t('schedule.heightStrategy.sliceHeightLabel')}</Label>
          <span className="text-xs font-mono text-muted-foreground">
            {t('schedule.heightStrategy.sliceHeightValue', {
              value: formatLocaleNumber(locale, heightTolerance, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
            })}
          </span>
        </div>
        <input
          id="gen-tol"
          type="range"
          min={0.5}
          max={10}
          step={0.25}
          value={heightTolerance}
          onChange={(e) => onHeightToleranceChange(parseFloat(e.target.value))}
          className="w-full accent-primary"
        />
        <p className="text-2xs text-muted-foreground">
          {t('schedule.heightStrategy.description')}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs">{t('schedule.heightStrategy.subdivideLabel')}</Label>
        <div className="grid grid-cols-4 gap-1.5">
          {([
            { k: 'none',  label: t('schedule.heightStrategy.optionNone')  },
            { k: 'class', label: t('schedule.heightStrategy.optionClass') },
            { k: 'type',  label: t('schedule.heightStrategy.optionType')  },
            { k: 'name',  label: t('schedule.heightStrategy.optionName')  },
          ] as const).map(opt => (
            <SubgroupPill
              key={opt.k}
              label={opt.label}
              active={elementZSubgroup === opt.k}
              onSelect={() => onSubgroupChange(opt.k)}
            />
          ))}
        </div>
        <p className="text-2xs text-muted-foreground">
          {elementZSubgroup === 'none'
            ? t('schedule.heightStrategy.subgroupNone')
            : elementZSubgroup === 'class'
            ? t('schedule.heightStrategy.subgroupClass')
            : elementZSubgroup === 'type'
            ? t('schedule.heightStrategy.subgroupType')
            : t('schedule.heightStrategy.subgroupName')}
        </p>
      </div>
    </div>
  );
}

interface SubgroupPillProps {
  label: string;
  active: boolean;
  onSelect: () => void;
}

/**
 * Compact 4-across segmented pill used for the Z-subgroup mode
 * (None / Class / Type / Name). Kept small and modest so it reads as a
 * setting, not a navigation target.
 */
function SubgroupPill({ label, active, onSelect }: SubgroupPillProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={
        'rounded border px-2 py-1 text-xs transition-colors ' +
        (active
          ? 'border-primary bg-primary/10 text-primary font-medium'
          : 'border-input text-muted-foreground hover:bg-muted/40 hover:text-foreground')
      }
    >
      {label}
    </button>
  );
}
