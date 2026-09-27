/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section chip (#5500, #5893, charter #5478 §6): while the Section tool
 * is closed and a cut is defined (`sectionPlane.enabled`), a `HudChip` in
 * the HUD's top-left region says which cut it is ("Down · 1.20 m", "Face ·
 * -0.35 m", "Box · 10.0×4.0×8.0 m"), with a visibility toggle (the cut is
 * lasting scene state now, #5893 — it stays on screen across tool switches
 * until the user hides it here), resume (reopen the tool on that cut) and
 * clear (forget it). The corner axis badge that used to draw over the Solo
 * chip (#5481) is gone; this chip stacks with the other status chips by
 * order instead.
 *
 * Always mounted (from `ViewportOverlays`); renders nothing while the
 * Section tool is open (the bar carries the state then) or with no cut
 * defined. Metres come from the same conversion the bar uses
 * (`useSectionDistance`), so the chip and the bar never disagree.
 */

import { Eye, EyeOff, RotateCcw, Scissors, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { clearSectionCut } from '@/store/section-active';
import { useTranslation } from '@/i18n';
import { HudChip, HudItem } from '../../viewport-ui/hud';
import { AXIS_INFO } from './sectionConstants';
import { useSectionDistance } from './useSectionDistance';
import { sectionBoxSize } from '@/lib/section/section-box';

export function SectionParkedChip() {
  const shown = useViewerStore((s) => s.sectionPlane.enabled && s.activeTool !== 'section');
  if (!shown) return null;
  return <ParkedChipBody />;
}

function ParkedChipBody() {
  const { t } = useTranslation();
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const visible = useViewerStore((s) => s.sceneState.section.visible);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setSectionVisible = useViewerStore((s) => s.setSectionVisible);
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
        toggle={{
          onClick: () => setSectionVisible(!visible),
          'aria-label': t(visible ? 'sectionTool.parked.hideAria' : 'sectionTool.parked.showAria'),
          title: t(visible ? 'sectionTool.parked.hideTitle' : 'sectionTool.parked.showTitle'),
          icon: visible
            ? <Eye aria-hidden className="h-3 w-3" />
            : <EyeOff aria-hidden className="h-3 w-3" />,
        }}
        resume={{
          onClick: () => {
            if (!visible) setSectionVisible(true);
            setActiveTool('section');
          },
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
