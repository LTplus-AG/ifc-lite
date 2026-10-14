/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's bar on the HUD's top-center region (#5499, charter
 * #5478 §6; two rows since #7545):
 *
 *   ✂ SECTION │ ◉A  ◉B  ◉C ⋯ │ ＋ Add plane │                       │ ✕
 *   Flip │ 1.20 m ▾ │ Cap ▾ │ ◉ Cut │ 2D section
 *
 * Row 1 says WHICH planes exist (chips, in creation order, the active one
 * filled, plus the one menu that adds a plane); row 2 edits the ACTIVE plane,
 * so no control has to say which plane it means. With no plane yet there is no
 * row 2 and row 1 offers the four ways to add one.
 *
 * Registered as the `section` row's `Bar` in `TOOL_HUD`, so `ToolOverlays`
 * places it (top-center, order 0); this component never positions itself.
 */

import { Scissors, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { cn } from '@/lib/utils';
import {
  HudPopover,
  HudPopoverAnchor,
  HudToolbar,
  useHudBarTier,
} from '../../viewport-ui/hud';
import { HudDivider } from '../../viewport-ui/hud/HudToggle';
import { SectionActivePlaneRow } from './SectionActivePlaneRow';
import { SectionAddMenu, SectionEmptyAdd } from './SectionAddMenu';
import { SectionPlaneChips } from './SectionPlaneChips';
import { useSectionPlaneSet } from './useSectionPlaneSet';
import { SectionBarMeasureContext } from './SectionBarMeasure';

/** One unbreakable run of controls on the bar. */
const GROUP = 'flex items-center gap-1';
/** One row of the bar; wraps only as a last resort in a very narrow lane. */
const ROW = 'flex flex-wrap items-center justify-center gap-1';
/** The bar's forms (#6315): with the caption, then without it. */
const TIER_CAPTION = 0;
const TIER_NO_CAPTION = 1;
const OFFSCREEN = { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' } as const;

export function SectionToolbar() {
  const { t } = useTranslation();
  // Row 1 is the group a wrap cannot break, so it is what must fit the
  // top-center lane: when it does not, the caption steps down (#5975)
  // instead of pushing the bar out of its lane (#6315). Only row 1 is measured.
  const { measureRef, tier } = useHudBarTier(TIER_NO_CAPTION);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const { count, atLimit } = useSectionPlaneSet();

  const caption = (
    <span className="flex items-center gap-1 whitespace-nowrap px-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
      <Scissors aria-hidden className="h-3.5 w-3.5 text-overlay-accent" />
      {t('sectionTool.heading')}
    </span>
  );
  const planes = count === 0 ? <SectionEmptyAdd /> : (
    <>
      <SectionPlaneChips />
      <SectionAddMenu atLimit={atLimit} />
    </>
  );
  const close = (
    <>
      <HudDivider />
      <Button variant="ghost" size="icon-sm" className="h-6 w-6" onClick={() => setActiveTool('select')} title={t('sectionTool.closeTitle')} aria-label={t('sectionTool.closeTitle')}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </>
  );

  return (
    <>
      {/* Row 1 with the caption, offscreen and hidden, only to be measured. */}
      <div ref={measureRef(TIER_CAPTION)} aria-hidden="true" inert style={OFFSCREEN}>
        <SectionBarMeasureContext.Provider value>
          <span className={cn(GROUP, 'px-1.5')}>
            {caption}
            <HudDivider />
            {planes}
            {close}
          </span>
        </SectionBarMeasureContext.Provider>
      </div>
      {/* The Cap popover is anchored to the whole bar, not to its trigger: when
          the bar wraps in a narrow top-center lane the trigger can sit on a
          middle row, and a trigger-anchored popover then opens over the rows
          below it (#5481). Anchored to the bar it always opens under the bar. */}
      <HudPopover>
        <HudPopoverAnchor asChild>
          <HudToolbar
            data-tool-bar="section"
            data-testid="section-toolbar"
            data-bar-tier={tier}
            className="flex-col flex-nowrap"
            {...tourAnchor(TOUR_ANCHORS.sectionPanel)}
          >
            <div className={ROW}>
              <span className={GROUP}>
                {tier === TIER_CAPTION && (
                  <>
                    {caption}
                    <HudDivider />
                  </>
                )}
                {planes}
                {close}
              </span>
            </div>
            {count > 0 && (
              <div className={ROW} data-testid="section-active-row">
                <SectionActivePlaneRow />
              </div>
            )}
          </HudToolbar>
        </HudPopoverAnchor>
      </HudPopover>
    </>
  );
}
