/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a cutting plane is added (#7545). The old bar's six-segment axis control
 * mixed three questions ("which direction", "how is the plane defined", "which
 * plane"); the first two are now this one menu, and adding NEVER replaces a
 * plane. The same four-way choice is the empty state's row of buttons.
 */

import { Plus } from 'lucide-react';
import { useTranslation } from '@/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MAX_SECTION_PLANES } from '@/lib/section/section-plane-set';
import { SECTION_ADD_ENTRIES, useAddSectionPlane } from './sectionAddActions';
import { useLiveTestId } from './SectionBarMeasure';
import { HudDivider } from '../../viewport-ui/hud/HudToggle';

const ACTION = 'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground';

/** The axis planes come first; the ways that need a pick or a shape follow a separator. */
const AXIS_ENTRIES = SECTION_ADD_ENTRIES.slice(0, 3);
const OTHER_ENTRIES = SECTION_ADD_ENTRIES.slice(3);

export function SectionAddMenu({ atLimit }: { atLimit: boolean }) {
  const { t } = useTranslation();
  const addTestId = useLiveTestId('section-add-plane');
  const menuTestId = useLiveTestId('section-add-menu');
  const add = useAddSectionPlane();
  const title = atLimit ? t('sectionPlanes.addLimit', { max: MAX_SECTION_PLANES }) : t('sectionPlanes.addTitle');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={ACTION} disabled={atLimit} title={title} aria-label={t('sectionPlanes.add')} data-testid={addTestId}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          {t('sectionPlanes.add')}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid={menuTestId}>
        {AXIS_ENTRIES.map((e) => (
          <DropdownMenuItem key={e.kind} title={t(e.titleKey)} onSelect={() => add(e.kind)}>{t(e.labelKey)}</DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {OTHER_ENTRIES.map((e) => (
          <DropdownMenuItem key={e.kind} title={t(e.titleKey)} onSelect={() => add(e.kind)}>{t(e.labelKey)}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The empty state: nothing cuts yet, so the common ways to start a cut sit right
 * on the bar's second row, grouped like the Add menu: the three axis planes, then
 * Face and Box (#8672: Box must be discoverable without first adding a plane).
 * Alignment is only in the Add menu, because it applies only to infrastructure models.
 */
export function SectionEmptyAdd() {
  const { t } = useTranslation();
  const testId = useLiveTestId('section-empty-add');
  const add = useAddSectionPlane();
  return (
    // Wraps in a lane narrower than the row (#8672 review), so every choice stays visible and clickable.
    <span className="flex flex-wrap items-center justify-center gap-1" data-testid={testId}>
      <span className="whitespace-nowrap px-1 text-xs text-muted-foreground">{t('sectionPlanes.empty')}</span>
      {AXIS_ENTRIES.map((e) => (
        <button key={e.kind} type="button" className={ACTION} title={t(e.titleKey)} onClick={() => add(e.kind)}>{t(e.labelKey)}</button>
      ))}
      <HudDivider />
      {OTHER_ENTRIES.filter((e) => e.kind !== 'alignment').map((e) => (
        <button key={e.kind} type="button" className={ACTION} title={t(e.titleKey)} onClick={() => add(e.kind)}>{t(e.labelKey)}</button>
      ))}
    </span>
  );
}
