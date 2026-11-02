/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How a cutting plane is added (#7545). The old bar's six-segment axis control
 * mixed three questions ("which direction", "how is the plane defined", "which
 * plane"); the first two are now this one menu, and adding NEVER replaces a
 * plane. The same four-way choice is the empty state's row of buttons.
 */

import { useCallback } from 'react';
import { Plus } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { sectionBoxFromBounds } from '@/lib/section/section-box';
import { chooseAlignmentMode, leaveAlignmentMode } from '@/lib/section/alignment-controller';
import { MAX_SECTION_PLANES } from '@/lib/section/section-plane-set';
import { useSectionDistance } from './useSectionDistance';
import { useLiveTestId } from './SectionBarMeasure';
import { HudDivider } from '../../viewport-ui/hud/HudToggle';
import type { SectionPlaneAxis } from '@/store/types';

export type AddKind = SectionPlaneAxis | 'face' | 'box' | 'alignment';

const ACTION = 'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground';

/** Add a plane of `kind`; false when the set is full. One place, so the menu and the empty state cannot differ. */
export function useAddSectionPlane(): (kind: AddKind) => boolean {
  const distance = useSectionDistance();
  return useCallback((kind) => {
    const store = useViewerStore.getState();
    leaveAlignmentMode();
    if (kind === 'down' || kind === 'front' || kind === 'side') return store.addSectionPlane(kind) !== null;
    if (kind === 'face') return store.armSectionFacePickForNewPlane();
    if (kind === 'alignment') {
      if (!store.prepareNewSectionPlane()) return false;
      chooseAlignmentMode();
      return true;
    }
    // A box fits the selection when there is one (the bounds Frame uses), else the model;
    // with neither known there is nothing to cut with, so no plane is made.
    const selected = store.cameraCallbacks.selectionBounds?.() ?? null;
    const box = sectionBoxFromBounds(selected) ?? sectionBoxFromBounds(distance.bounds);
    if (!box || !store.prepareNewSectionPlane()) return false;
    useViewerStore.getState().setSectionBox(box);
    return true;
  }, [distance.bounds]);
}

type AddLabelKey = 'sectionPlanes.addDown' | 'sectionPlanes.addFront' | 'sectionPlanes.addSide' | 'sectionPlanes.addFace' | 'sectionPlanes.addBox' | 'sectionPlanes.addAlignment';
type AddTitleKey = 'sectionPlanes.addDownTitle' | 'sectionPlanes.addFrontTitle' | 'sectionPlanes.addSideTitle' | 'sectionPlanes.addFaceTitle' | 'sectionPlanes.addBoxTitle' | 'sectionPlanes.addAlignmentTitle';

/** Every way to add, with a title that says what it makes, so each choice explains itself on hover (#8672). */
const ENTRIES: ReadonlyArray<{ kind: AddKind; labelKey: AddLabelKey; titleKey: AddTitleKey }> = [
  { kind: 'down', labelKey: 'sectionPlanes.addDown', titleKey: 'sectionPlanes.addDownTitle' },
  { kind: 'front', labelKey: 'sectionPlanes.addFront', titleKey: 'sectionPlanes.addFrontTitle' },
  { kind: 'side', labelKey: 'sectionPlanes.addSide', titleKey: 'sectionPlanes.addSideTitle' },
  { kind: 'face', labelKey: 'sectionPlanes.addFace', titleKey: 'sectionPlanes.addFaceTitle' },
  { kind: 'box', labelKey: 'sectionPlanes.addBox', titleKey: 'sectionPlanes.addBoxTitle' },
  { kind: 'alignment', labelKey: 'sectionPlanes.addAlignment', titleKey: 'sectionPlanes.addAlignmentTitle' },
];
/** The axis planes come first; the ways that need a pick or a shape follow a separator. */
const AXIS_ENTRIES = ENTRIES.slice(0, 3);
const OTHER_ENTRIES = ENTRIES.slice(3);

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
 * The empty state: nothing cuts yet, so every way to start a cut sits right on
 * the bar, grouped like the Add menu: the three axis planes, then Face and Box
 * (#8672: Box must be discoverable without first adding a plane). Alignment
 * stays in the Add menu; it only applies to infrastructure models.
 */
export function SectionEmptyAdd() {
  const { t } = useTranslation();
  const testId = useLiveTestId('section-empty-add');
  const add = useAddSectionPlane();
  return (
    <span className="flex items-center gap-1" data-testid={testId}>
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
