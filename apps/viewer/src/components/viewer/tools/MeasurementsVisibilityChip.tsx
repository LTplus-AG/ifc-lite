/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The measurements chip (#5893, mirrors `SectionParkedChip`): while the
 * Measure tool is closed and at least one finished measurement exists, a
 * `HudChip` in the HUD's top-left region names the count, with a visibility
 * toggle (`sceneState.measurements.visible`, drawn by the always-mounted
 * `MeasurementSceneLayer`) and a clear action.
 *
 * Always mounted (from `ViewportOverlays`); renders nothing while the
 * Measure tool is open (its own bar carries the count then, via
 * `MeasureToolbar`'s Measurements-panel button) or with nothing measured.
 */

import { Eye, EyeOff, Ruler, Trash2 } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { HudChip, HudItem } from '../../viewport-ui/hud';

export function MeasurementsVisibilityChip() {
  const shown = useViewerStore(
    (s) => s.activeTool !== 'measure' && (s.measurements.length > 0 || s.polylineMeasurements.length > 0),
  );
  if (!shown) return null;
  return <MeasurementsChipBody />;
}

function MeasurementsChipBody() {
  const { t } = useTranslation();
  const count = useViewerStore((s) => s.measurements.length + s.polylineMeasurements.length);
  const visible = useViewerStore((s) => s.sceneState.measurements.visible);
  const setMeasurementsVisible = useViewerStore((s) => s.setMeasurementsVisible);
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);

  // Order 3: after the edit-mode chip (0), the level-display chip (1) and
  // the section chip (2).
  return (
    <HudItem region="top-left" order={3}>
      <HudChip
        icon={<Ruler aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />}
        toggle={{
          onClick: () => setMeasurementsVisible(!visible),
          'aria-label': t(visible ? 'measure.chip.hideAria' : 'measure.chip.showAria'),
          title: t(visible ? 'measure.chip.hideTitle' : 'measure.chip.showTitle'),
          icon: visible
            ? <Eye aria-hidden className="h-3 w-3" />
            : <EyeOff aria-hidden className="h-3 w-3" />,
        }}
        dismiss={{
          onClick: () => clearMeasurements(),
          'aria-label': t('measure.chip.clearAria'),
          title: t('measure.chip.clearTitle'),
          icon: <Trash2 aria-hidden className="h-3 w-3" />,
        }}
      >
        {t('measure.chip.label', { count: String(count) })}
      </HudChip>
    </HudItem>
  );
}
