/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool's bar on the HUD's top-center region (#5502, charter
 * #5478 item 20): mode, angle kind, snap, geo XYZ, the Measurements panel,
 * clear, close. It carries no readouts of its own — the list, point and
 * quantity readouts live in the `measurements` side panel, the hint in
 * `MeasureHint` and the geo readout in `MeasureGeoReadout`.
 */

import { useCallback } from 'react';
import { Globe, List, Magnet, Ruler, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n/useTranslation';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { HudItem, HudSegmented, HudToolbar, type HudSegmentedOption } from '../../viewport-ui/hud';
import { HudDivider, HudToggle } from '../../viewport-ui/hud/HudToggle';
import { ANGLE_KIND_LABELS, MEASURE_MODE_LABELS } from './measure-modes/readouts';
import type { AngleKind, MeasureMode } from '@/store/types';

/** The Measurements panel counts as open when docked, floating or popped out. */
function selectMeasurementsPanelOpen(s: {
  sidebarActivePanel: string;
  floatingPanels: ReadonlyArray<{ id: string }>;
  poppedOutIds: readonly string[];
}): boolean {
  return (
    s.sidebarActivePanel === 'measurements' ||
    s.floatingPanels.some((p) => p.id === 'measurements') ||
    s.poppedOutIds.includes('measurements')
  );
}

export function MeasureToolbar() {
  const { t } = useTranslation();
  const measureMode = useViewerStore((s) => s.measureMode);
  const setMeasureMode = useViewerStore((s) => s.setMeasureMode);
  const angleKind = useViewerStore((s) => s.angleKind);
  const setAngleKind = useViewerStore((s) => s.setAngleKind);
  const snapEnabled = useViewerStore((s) => s.snapEnabled);
  const toggleSnap = useViewerStore((s) => s.toggleSnap);
  const geoReadoutEnabled = useViewerStore((s) => s.geoReadoutEnabled);
  const toggleGeoReadout = useViewerStore((s) => s.toggleGeoReadout);
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const toggleWorkspacePanel = useViewerStore((s) => s.toggleWorkspacePanel);
  const panelOpen = useViewerStore(selectMeasurementsPanelOpen);
  const count = useViewerStore(
    (s) =>
      s.measurements.length +
      s.polylineMeasurements.length +
      s.angleMeasurements.length +
      s.radiusMeasurements.length,
  );
  // `anchor` is non-null only when the georef anchor model carries a usable
  // IfcMapConversion; Geo XYZ stays visible without one so the feature is
  // discoverable, disabled with an explanatory tooltip instead of vanishing.
  const anchor = useAnchorGeoreference();

  const modes: HudSegmentedOption<MeasureMode>[] = MEASURE_MODE_LABELS.map(([value, key]) => ({
    value,
    label: t(key),
  }));
  const kinds: HudSegmentedOption<AngleKind>[] = ANGLE_KIND_LABELS.map(([value, key, hintKey]) => ({
    value,
    label: t(key),
    title: t(hintKey),
  }));

  const handleClear = useCallback(async () => {
    if (await confirmDialog({ description: t('measure.clearAllConfirm'), destructive: true })) clearMeasurements();
  }, [clearMeasurements, t]);

  return (
    <HudItem region="top-center" order={0}>
      <HudToolbar data-testid="measure-toolbar">
        <span className="flex items-center gap-1 px-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          <Ruler aria-hidden className="h-3.5 w-3.5 text-overlay-accent" />
          {t('measure.panelTitle')}
        </span>
        <HudDivider />
        <HudSegmented options={modes} value={measureMode} onChange={setMeasureMode} aria-label={t('measure.bar.modeAria')} />
        {measureMode === 'angle' && (
          <>
            <HudDivider />
            {/* `setAngleKind` discards a half-placed sequence itself: its
                picks belong to the OLD kind and need a different count. */}
            <HudSegmented options={kinds} value={angleKind} onChange={setAngleKind} aria-label={t('measure.bar.angleKindAria')} />
          </>
        )}
        <HudDivider />
        <HudToggle pressed={snapEnabled} onPressedChange={toggleSnap} title={t('measure.snapToggle.title')} icon={<Magnet aria-hidden className="h-3.5 w-3.5" />}>
          {t('measure.snap.label')}
        </HudToggle>
        <HudToggle
          pressed={geoReadoutEnabled && anchor !== null}
          disabled={anchor === null}
          onPressedChange={toggleGeoReadout}
          title={anchor ? t('measure.geoToggle.enabledTitle') : t('measure.geoToggle.disabledTitle')}
          icon={<Globe aria-hidden className="h-3.5 w-3.5" />}
        >
          {t('measure.geo.label')}
        </HudToggle>
        <HudDivider />
        <HudToggle
          pressed={panelOpen}
          onPressedChange={() => toggleWorkspacePanel('measurements')}
          title={t('measure.panel.toggleTitle')}
          icon={<List aria-hidden className="h-3.5 w-3.5" />}
        >
          {t('measure.section.list.label')}
          {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
        </HudToggle>
        {count > 0 && (
          <Button variant="ghost" size="icon-sm" className="h-6 w-6" onClick={handleClear} title={t('measure.clearAll')} aria-label={t('measure.clearAll')}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" className="h-6 w-6" onClick={() => setActiveTool('select')} title={t('measure.close')} aria-label={t('measure.close')}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </HudToolbar>
    </HudItem>
  );
}
