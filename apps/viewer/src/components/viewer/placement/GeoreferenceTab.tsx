/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `placement` side panel's Georeference tab (#5505): the metrics,
 * map-absolute warning, nudge pad and apply/reset actions that used to live
 * in `CesiumPlacementEditor`'s floating card. The drag gizmo itself stays a
 * scene overlay (`CesiumPlacementGizmo`); this tab reads and drives the same
 * store-held draft through `useCesiumPlacementController`, so dragging in the
 * 3D view and nudging here stay in lock-step.
 */
import { Check, RotateCcw } from 'lucide-react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { formatSigned } from './cesium-placement-math';
import { useCesiumPlacementController } from './useCesiumPlacementController';

export interface GeoreferenceTabProps {
  modelId: string;
  mapConversion: MapConversion;
  baseMapConversion: MapConversion;
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale?: number;
}

export function GeoreferenceTab(props: GeoreferenceTabProps) {
  const { t } = useTranslation();
  const c = useCesiumPlacementController(props);

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
          {c.editMode ? t('placementPanel.georeference.editToggleOn') : t('placementPanel.georeference.editToggleOff')}
        </span>
        <Switch checked={c.editMode} onCheckedChange={(checked) => (checked ? c.beginEditing() : c.handleClose())} aria-label={t('cesiumGeo.placement.headerTitle')} />
      </div>

      {!c.editMode && (
        <p className="text-[9px] leading-snug text-muted-foreground">{t('placementPanel.georeference.startHint')}</p>
      )}

      {c.editMode && (
        <>
          <div className="grid grid-cols-4 gap-1 border-b pb-2">
            <Metric label={t('cesiumGeo.placement.deltaELabel')} value={formatSigned(c.deltaE, c.mapUnitSuffix)} accent="text-emerald-700 dark:text-emerald-300" />
            <Metric label={t('cesiumGeo.placement.deltaNLabel')} value={formatSigned(c.deltaN, c.mapUnitSuffix)} accent="text-emerald-700 dark:text-emerald-300" />
            <Metric label={t('cesiumGeo.placement.deltaZLabel')} value={formatSigned(c.deltaH, c.mapUnitSuffix)} accent="text-amber-700 dark:text-amber-300" />
            <Metric label={t('cesiumGeo.placement.deltaRLabel')} value={formatSigned(c.deltaAngle, 'deg')} accent="text-sky-700 dark:text-sky-300" />
          </div>

          {c.mapAbsoluteActive && (
            <output data-testid="cesium-placement-map-absolute-warning"
              className="block border border-amber-500 bg-amber-50 dark:bg-amber-950/40 px-2 py-1.5 text-[9px] leading-snug text-amber-800 dark:text-amber-300">
              {t('cesiumGeo.placement.mapAbsoluteWarning')}
            </output>
          )}

          <div className="space-y-1">
            <div className="pb-1 text-[9px] leading-snug text-muted-foreground">{t('cesiumGeo.placement.dragHint')}</div>
            <PreviewRow label="Eastings" value={`${c.activeDraft.eastings.toFixed(2)} ${c.mapUnitSuffix}`} />
            <PreviewRow label="Northings" value={`${c.activeDraft.northings.toFixed(2)} ${c.mapUnitSuffix}`} />
            <PreviewRow label="OrthogonalHeight" value={`${c.activeDraft.orthogonalHeight.toFixed(2)} ${c.mapUnitSuffix}`} />
            <PreviewRow label={t('cesiumGeo.placement.xAxisAngleLabel')} value={`${c.activeAngle.toFixed(2)} deg`} />
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 text-[9px]">
            <span className="text-muted-foreground uppercase tracking-wider">{t('cesiumGeo.placement.nudgeOneMeter')}</span>
            <NudgeButton onClick={() => c.nudge(0, c.nudgeStep)} aria-label={t('cesiumGeo.placement.nudgeNorthAriaLabel')}>{t('cesiumGeo.placement.nudgeNorthLabel')}</NudgeButton>
            <span />
            <NudgeButton onClick={() => c.nudge(-c.nudgeStep, 0)} aria-label={t('cesiumGeo.placement.nudgeWestAriaLabel')}>{t('cesiumGeo.placement.nudgeWestLabel')}</NudgeButton>
            <NudgeButton onClick={() => c.nudge(c.nudgeStep, 0)} aria-label={t('cesiumGeo.placement.nudgeEastAriaLabel')}>{t('cesiumGeo.placement.nudgeEastLabel')}</NudgeButton>
            <NudgeButton onClick={() => c.nudge(0, -c.nudgeStep)} aria-label={t('cesiumGeo.placement.nudgeSouthAriaLabel')}>{t('cesiumGeo.placement.nudgeSouthLabel')}</NudgeButton>
          </div>

          <div className="flex items-center gap-1 text-[9px]">
            <span className="mr-auto text-muted-foreground uppercase tracking-wider">{t('cesiumGeo.placement.heightLabel')}</span>
            <NudgeButton onClick={() => c.nudgeHeight(-c.nudgeStep)} aria-label={t('cesiumGeo.placement.nudgeHeightDownAriaLabel')}>{t('cesiumGeo.placement.nudgeHeightDownLabel')}</NudgeButton>
            <NudgeButton onClick={() => c.nudgeHeight(c.nudgeStep)} aria-label={t('cesiumGeo.placement.nudgeHeightUpAriaLabel')}>{t('cesiumGeo.placement.nudgeHeightUpLabel')}</NudgeButton>
          </div>

          <div className="flex items-center gap-1 text-[9px]">
            <span className="mr-auto text-muted-foreground uppercase tracking-wider">{t('cesiumGeo.placement.rotateLabel')}</span>
            <NudgeButton onClick={() => c.nudgeRotation(-1)} aria-label={t('cesiumGeo.placement.rotateNegAriaLabel')}>{t('cesiumGeo.placement.rotateNegLabel')}</NudgeButton>
            <NudgeButton onClick={() => c.nudgeRotation(1)} aria-label={t('cesiumGeo.placement.rotatePosAriaLabel')}>{t('cesiumGeo.placement.rotatePosLabel')}</NudgeButton>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" className="flex-1 gap-1.5" disabled={!c.dirty} onClick={c.handleApply}>
              <Check className="h-3 w-3" />{t('cesiumGeo.placement.applyButton')}
            </Button>
            <Button size="sm" variant="outline" className="gap-1" disabled={!c.dirty} onClick={c.handleReset}>
              <RotateCcw className="h-3 w-3" />{t('cesiumGeo.placement.resetButton')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div className="text-[8px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 whitespace-nowrap text-[10px] font-semibold', accent)}>{value}</div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function NudgeButton({ children, onClick, ...rest }: { children: React.ReactNode; onClick: () => void } & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>) {
  return (
    <Button type="button" variant="outline" size="sm" className="h-7 px-2 font-bold tracking-wider" onClick={onClick} {...rest}>
      {children}
    </Button>
  );
}
