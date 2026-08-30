/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "Anonymization" section of the anonymized isolated export dialog.
 *
 * Every toggle follows ONE polarity: switch ON (right) = **Anonymize** (red,
 * the data is cleaned), switch OFF (left) = **Keep** (dim green, exported as
 * authored). Everything defaults to ON. The core `AnonymizeOptions` mixes
 * "keep" and "remove" flags (`keepPropertySets` vs `zeroRootPlacement`), which
 * reads fine in code but made a row of checkboxes ambiguous in the UI; the
 * mapping lives in `toAnonymizeOptions` so the dialog never inverts a flag by
 * hand.
 */

import type { AnonymizeOptions } from '@ifc-lite/export';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** UI-side state: every field means "anonymize this in the export". */
export interface AnonymizeToggles {
  names: boolean;
  /** ObjectType/Phase plus non-IfcRoot names: surface styles, materials, layers, profiles, colours. */
  otherNames: boolean;
  globalIds: boolean;
  propertySets: boolean;
  rootPlacementPosition: boolean;
  georeferencing: boolean;
  /** IfcMonetaryUnit.Currency → USD. */
  currency: boolean;
}

/** Maximally scrubbed: everything anonymized. */
export const DEFAULT_ANONYMIZE_TOGGLES: Readonly<AnonymizeToggles> = {
  names: true,
  otherNames: true,
  globalIds: true,
  propertySets: true,
  rootPlacementPosition: true,
  georeferencing: true,
  currency: true,
};

/**
 * ONE DECISION, TWO CONTROLS (#3351).
 *
 * "Property sets -> Anonymize" only ever cleared `HasPropertySets` on type
 * classes, so a pset pulled in by the `IfcRelDefinesByProperties` walk survived
 * with its values while the label said it was dropped. The CLI has never had
 * this bug because `--keep-psets` drives BOTH the walk and `keepPropertySets`
 * from one flag.
 *
 * These two functions give the dialog the same invariant from either side, so
 * the state "walk on AND psets anonymized" is unreachable. Pure on purpose:
 * the rule is the thing worth testing, and it should not need a rendered
 * dialog to exercise.
 */
export function coupleTogglesToRelations(
  next: AnonymizeToggles,
  relationPsetsOn: boolean,
): { toggles: AnonymizeToggles; turnRelationOff: boolean } {
  return { toggles: next, turnRelationOff: next.propertySets && relationPsetsOn };
}

/** The mirror: turning the source-pset walk ON means keeping them. */
export function coupleRelationsToToggles(
  current: AnonymizeToggles,
  relationPsetsTurnedOn: boolean,
): AnonymizeToggles {
  if (!relationPsetsTurnedOn || !current.propertySets) return current;
  return { ...current, propertySets: false };
}

/** Translate the uniform Anonymize/Keep state into the core's mixed-polarity flags. */
export function toAnonymizeOptions(t: AnonymizeToggles): AnonymizeOptions {
  return {
    pseudonymizeNames: t.names,
    pseudonymizeAllNames: t.otherNames,
    regenerateGlobalIds: t.globalIds,
    keepPropertySets: !t.propertySets,
    zeroRootPlacement: t.rootPlacementPosition,
    removeGeoreferencing: t.georeferencing,
    neutralizeCurrency: t.currency,
  };
}

interface ToggleRow {
  key: keyof AnonymizeToggles;
  label: string;
  /** What anonymizing does, shown as the row's helper text. */
  effect: string;
}

const ROWS: readonly ToggleRow[] = [
  { key: 'names', label: 'Names', effect: 'Name/LongName/Description/Tag become IfcType-n' },
  { key: 'otherNames', label: 'Other names', effect: 'ObjectType, styles, materials, layers, profiles' },
  { key: 'globalIds', label: 'GUIDs', effect: 'GlobalIds regenerated' },
  { key: 'propertySets', label: 'Property sets', effect: 'Property and quantity sets dropped' },
  { key: 'rootPlacementPosition', label: 'Root placement position', effect: 'Root translation zeroed; rotation kept' },
  { key: 'georeferencing', label: 'Georeferencing & addresses', effect: 'Map conversion, CRS, lat/long, addresses removed' },
  { key: 'currency', label: 'Currency', effect: 'IfcMonetaryUnit becomes USD' },
];

interface AnonymizationOptionsPanelProps {
  toggles: AnonymizeToggles;
  onTogglesChange: (next: AnonymizeToggles) => void;
  disabled?: boolean;
}

export function AnonymizationOptionsPanel({ toggles, onTogglesChange, disabled }: AnonymizationOptionsPanelProps) {
  return (
    <div className="space-y-2 pt-1 border-t">
      <div className="flex items-baseline justify-between pt-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Anonymization</div>
        <div className="text-[11px] text-muted-foreground">
          <span className="text-emerald-700/70 dark:text-emerald-400/70 font-medium">Keep</span>
          {' / '}
          <span className="text-red-600 dark:text-red-400 font-medium">Anonymize</span>
        </div>
      </div>

      <div className="space-y-1.5">
        {ROWS.map((row) => {
          const on = toggles[row.key];
          const id = `anon-toggle-${row.key}`;
          return (
            <div key={row.key} className="flex items-center gap-3">
              <Switch
                id={id}
                checked={on}
                disabled={disabled}
                onCheckedChange={(checked) => onTogglesChange({ ...toggles, [row.key]: checked })}
                aria-label={`Anonymize ${row.label}`}
                className="data-[state=checked]:bg-red-500 data-[state=unchecked]:bg-emerald-600/40"
              />
              <Label htmlFor={id} className="flex-1 flex items-baseline gap-2 text-sm cursor-pointer">
                <span>{row.label}</span>
                <span className="text-[11px] text-muted-foreground truncate">
                  {on ? row.effect : 'kept as authored'}
                </span>
              </Label>
              <span
                className={cn(
                  'text-[11px] font-medium w-16 text-right',
                  on ? 'text-red-600 dark:text-red-400' : 'text-emerald-700/70 dark:text-emerald-400/70',
                )}
              >
                {on ? 'Anonymize' : 'Keep'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
