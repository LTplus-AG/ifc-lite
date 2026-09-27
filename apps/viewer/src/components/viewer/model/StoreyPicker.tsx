/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's storey list (charter #6232, M2 §1.4): the same
 * markup as the Section bar's storey menu, one row per storey, highest
 * first, the current one marked with `aria-current`. With several editable
 * models the rows are grouped under each model's name. Shared by the HUD
 * storey chip and, from M2.4, the plan header.
 */

import { Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import type { WorkspaceStorey } from '@/lib/commands/modeling/workspace-storeys';

export interface StoreyPickerGroup {
  readonly modelId: string;
  /** Shown as a group heading when there is more than one group. */
  readonly modelName: string;
  readonly storeys: readonly WorkspaceStorey[];
}

export interface StoreyPickerProps {
  groups: readonly StoreyPickerGroup[];
  current: { modelId: string; storeyId: number | null } | null;
  onPick: (storey: WorkspaceStorey) => void;
}

/** "+3.00", "−0.40", "±0.00": the sign always shows, so a basement reads as one. */
export function formatStoreyElevation(elevation: number): string {
  const value = Math.abs(elevation).toFixed(2);
  if (Number(value) === 0) return `±${value}`;
  return `${elevation > 0 ? '+' : '−'}${value}`;
}

export function StoreyPicker({ groups, current, onPick }: StoreyPickerProps) {
  const { t } = useTranslation();
  const grouped = groups.length > 1;
  return (
    <div data-storey-picker className="max-h-64 overflow-y-auto">
      {groups.map((group) => (
        <div key={group.modelId}>
          {grouped && (
            <div className="truncate px-2 pb-0.5 pt-1.5 text-2xs font-medium text-muted-foreground">{group.modelName}</div>
          )}
          <ul aria-label={grouped ? group.modelName : t('modelWorkspace.storey.listAria')}>
            {[...group.storeys].reverse().map((storey) => {
              const active = current?.modelId === storey.modelId && current.storeyId === storey.expressId;
              return (
                <li key={storey.expressId}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onPick(storey)}
                    className={cn(
                      'flex w-full items-center justify-between gap-4 rounded-sm px-2 py-1 text-left text-xs',
                      active ? 'bg-overlay-accent-soft text-overlay-accent' : 'hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Layers aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{storey.name}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {t('modelWorkspace.storey.elevation', { elevation: formatStoreyElevation(storey.elevation) })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
