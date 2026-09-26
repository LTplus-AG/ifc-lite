/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parked-section chip (#5500, charter #5478 §6): while a cut is parked
 * — the user left the Section tool with clipping on (`sectionPlane.parked`,
 * `store/section-active.ts`) — a `HudChip` in the HUD's top-left region
 * says which cut is waiting ("Down · 1.20 m", "Face · -0.35 m", "Box ·
 * 10.0×4.0×8.0 m"), with
 * resume (reopen the tool on that cut) and clear (forget it). The corner
 * axis badge that used to draw over the Solo chip (#5481) is gone; this
 * chip stacks with the other status chips by order instead.
 *
 * Always mounted (from `ViewportOverlays`); renders nothing unless a cut is
 * parked and the tool is closed. Metres come from the same conversion the
 * bar uses (`useSectionDistance`), so the chip and the bar never disagree.
 */

import { RotateCcw, Scissors, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { clearSectionCut } from '@/store/section-active';
import { useTranslation } from '@/i18n';
import { HudChip, HudItem } from '../../viewport-ui/hud';
import { AXIS_INFO } from './sectionConstants';
import { useSectionDistance } from './useSectionDistance';
import { sectionBoxSize } from '@/lib/section/section-box';

export function SectionParkedChip() {
  const parked = useViewerStore((s) => s.sectionPlane.parked === true && s.activeTool !== 'section');
  if (!parked) return null;
  return <ParkedChipBody />;
}

function ParkedChipBody() {
  const { t } = useTranslation();
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const distance = useSectionDistance();

  const axis = sectionPlane.custom ? t('sectionTool.parked.faceAxis') : t(AXIS_INFO[sectionPlane.axis].labelKey);
  const box = sectionPlane.box ? sectionBoxSize(sectionPlane.box) : null;
  // One decimal and tight separators: the chip's lane is 13rem, and the bar
  // carries the precise size while the tool is open.
  const label = box
    ? t('sectionTool.parked.labelBox', { x: box[0].toFixed(1), y: box[1].toFixed(1), z: box[2].toFixed(1) })
    : distance.kind === 'percent'
      ? t('sectionTool.parked.labelPercent', { axis, position: distance.value.toFixed(1) })
      : t('sectionTool.parked.label', { axis, distance: distance.value.toFixed(2) });

  // Order 2: after the edit-mode chip (0) and the level-display chip (1).
  return (
    <HudItem region="top-left" order={2}>
      <HudChip
        icon={<Scissors aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />}
        resume={{
          onClick: () => setActiveTool('section'),
          'aria-label': t('sectionTool.parked.resumeAria'),
          title: t('sectionTool.parked.resumeTitle'),
          icon: <RotateCcw aria-hidden className="h-3 w-3" />,
        }}
        dismiss={{
          onClick: () => clearSectionCut(useViewerStore.getState),
          'aria-label': t('sectionTool.parked.clearAria'),
          title: t('sectionTool.parked.clearTitle'),
          icon: <X aria-hidden className="h-3 w-3" />,
        }}
      >
        {label}
      </HudChip>
    </HudItem>
  );
}
