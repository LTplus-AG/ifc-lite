/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Beam / Member and Column commands' bars with their Section picker
 * (charter #6232, D2): the class and Chain controls they had, then one
 * button showing the section new elements get. It opens the same editor the
 * Model inspector's Defaults mode shows (`DefaultsProfileEditor`): the kinds
 * (rectangle, I, L, T, U/C, circle, hollow rectangle, hollow circle), the
 * dimensions the kind needs, and a preview. The ghost and the commit read
 * the same defaults, so what is shown is what is placed.
 */

import { useSyncExternalStore } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { authoringShownSection, type ProfileOwner } from '@/store/slices/authoringDefaultsSlice';
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@/components/ui/popover';
import { PROFILE_KIND_LABEL } from '@/lib/profile-section/profile-kinds';
import { DefaultsProfileEditor } from '../../profile-section/DefaultsProfileEditor';
import { SectionPreview } from '../../profile-section/SectionPreview';
import { HudDivider } from '../../../viewport-ui/hud';
import type { CommandContext, CommandHudProps } from '@/lib/commands/modeling/types';
import { BeamPlaceBar } from './PlacementBars';

/**
 * Which picker is open, for which running command. Not component state: the
 * bar changes shape when its content gets wider (a longer section name), which
 * remounts it, and an open picker must not close under the user's hand. Keyed
 * by the command's context, so a picker never opens by itself in the next run.
 */
let openPicker: { owner: ProfileOwner; ctx: CommandContext } | null = null;
const listeners = new Set<() => void>();
function setPickerOpen(owner: ProfileOwner, ctx: CommandContext, open: boolean): void {
  openPicker = open ? { owner, ctx } : null;
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const pickerSnapshot = () => openPicker;

function ProfilePicker({ owner, ctx, measuring }: { owner: ProfileOwner; ctx: CommandContext; measuring?: boolean }) {
  const { t } = useTranslation();
  const defaults = useViewerStore((s) => s.authoringDefaults);
  const picked = useSyncExternalStore(subscribe, pickerSnapshot);
  const { type } = defaults.profiles[owner];
  const shown = authoringShownSection(defaults, owner);
  const kind = t(PROFILE_KIND_LABEL[type]);
  return (
    <Popover modal open={!measuring && picked?.owner === owner && picked.ctx === ctx} onOpenChange={(open) => setPickerOpen(owner, ctx, open)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          tabIndex={measuring ? -1 : undefined}
          data-profile-picker={owner}
          title={t('profileSection.picker.title')}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent"
        >
          <SectionPreview section={shown} size={16} />
          {t('profileSection.picker.button', { kind })}
          <ChevronDown aria-hidden className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent align="center" className="w-72 space-y-2 p-3" onKeyDown={(event) => event.stopPropagation()}>
          <h3 className="text-xs font-medium">{t('profileSection.picker.label')}</h3>
          <DefaultsProfileEditor owner={owner} />
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}

/** The Beam bar: its class and Chain, then the Section of the picked class. */
export function BeamPlaceProfileBar({ ctx, measuring }: Pick<CommandHudProps<unknown>, 'ctx' | 'measuring'>) {
  const beamClass = useViewerStore((s) => s.authoringDefaults.beamClass);
  return (
    <>
      <BeamPlaceBar />
      <HudDivider />
      <ProfilePicker owner={beamClass} ctx={ctx} measuring={measuring} />
    </>
  );
}

/** The Column bar: the Section picker after the typed fields. */
export function ColumnPlaceProfileBar({ ctx, measuring }: Pick<CommandHudProps<unknown>, 'ctx' | 'measuring'>) {
  return (
    <>
      <HudDivider />
      <ProfilePicker owner="column" ctx={ctx} measuring={measuring} />
    </>
  );
}
