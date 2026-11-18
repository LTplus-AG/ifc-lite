/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Georeferencing check" in the Georeference panel (#10608): the
 * `@ifc-lite/georef-check` diagnosis of the model as edited, findings by
 * severity, and an "Apply fix" for the ones the SDK planner marks safe.
 *
 * A position outside the CRS's EPSG area of use is shown above the
 * collapsible list, because it means the model lands in the wrong place.
 * Findings the panel already explains in its own notices (#2526's double
 * map position, the scale note) say so instead of repeating it; the double
 * position keeps no fix, as the panel's note explains why it must not.
 * An IfcSite location fix is written as positional attribute edits, the
 * SDK's `bim.georef.setSite` encoding (#10659), and the check re-runs when
 * this session's site location changes.
 *
 * Mounted through `georef-diagnosis-gate` (`React.lazy`), so this file and
 * everything it imports load only when the panel shows.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, Info, Stethoscope } from 'lucide-react';
import type { GeorefFindingCode, Severity } from '@ifc-lite/sdk/georef-doctor';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { newMutationBatchId } from '@/store/slices/mutation-batch-tags';
import { posthog } from '@/lib/analytics';
import { useTranslation, type TranslationKey } from '@/i18n';
import { diagnoseModelGeoreference, editedSiteLocation, type DiagnosisItem, type GeorefDiagnosis } from '@/lib/geo/georef-diagnosis';
import { writeSiteLocation } from '@/lib/geo/site-location-write';
import { findingDetail } from './georef-finding-detail';
import { areaOfUseText } from './epsg-area-of-use';
import { INSPECTOR_COUNT, InspectorSectionTrigger } from './inspector-ui';

export interface GeorefDiagnosisSectionProps {
  modelId: string;
  editable?: boolean;
  /** Metres per map unit of the edited CRS (used when MapUnit was edited). */
  mapUnitScale?: number;
  /** Notices the panel itself shows for this model. */
  shownInPanel: { doubleGeoref: boolean; scaleMismatch: boolean };
}

const CODE_TITLE: Record<GeorefFindingCode, TranslationKey> = {
  NO_GEOREFERENCE: 'properties.georef.check.code.NO_GEOREFERENCE',
  SITE_LOCATION_ONLY: 'properties.georef.check.code.SITE_LOCATION_ONLY',
  SITE_LOCATION_DEFAULT: 'properties.georef.check.code.SITE_LOCATION_DEFAULT',
  SITE_LOCATION_CONTRADICTS_OPERATION: 'properties.georef.check.code.SITE_LOCATION_CONTRADICTS_OPERATION',
  MAP_POSITION_APPLIED_TWICE: 'properties.georef.check.code.MAP_POSITION_APPLIED_TWICE',
  MAP_COORDINATES_IN_PLACEMENTS: 'properties.georef.check.code.MAP_COORDINATES_IN_PLACEMENTS',
  SCALE_UNIT_MISMATCH: 'properties.georef.check.code.SCALE_UNIT_MISMATCH',
  SCALE_DOES_NOT_BRIDGE_UNITS: 'properties.georef.check.code.SCALE_DOES_NOT_BRIDGE_UNITS',
  SCALE_INVALID: 'properties.georef.check.code.SCALE_INVALID',
  EASTING_ZONE_PREFIX: 'properties.georef.check.code.EASTING_ZONE_PREFIX',
  EASTING_ZONE_PREFIX_MISSING: 'properties.georef.check.code.EASTING_ZONE_PREFIX_MISSING',
  LV03_LV95_MIX: 'properties.georef.check.code.LV03_LV95_MIX',
  OUTSIDE_CRS_AREA: 'properties.georef.check.code.OUTSIDE_CRS_AREA',
  CRS_NOT_RESOLVABLE: 'properties.georef.check.code.CRS_NOT_RESOLVABLE',
  OPERATION_WITHOUT_CRS: 'properties.georef.check.code.OPERATION_WITHOUT_CRS',
  CRS_WITHOUT_OPERATION: 'properties.georef.check.code.CRS_WITHOUT_OPERATION',
  MAP_UNIT_MISSING: 'properties.georef.check.code.MAP_UNIT_MISSING',
  VERTICAL_DATUM_MISSING: 'properties.georef.check.code.VERTICAL_DATUM_MISSING',
  ROTATION_INVALID: 'properties.georef.check.code.ROTATION_INVALID',
  ROTATION_NOT_UNIT_LENGTH: 'properties.georef.check.code.ROTATION_NOT_UNIT_LENGTH',
  TRUE_NORTH_CONTRADICTS_ROTATION: 'properties.georef.check.code.TRUE_NORTH_CONTRADICTS_ROTATION',
  ORTHOGONAL_HEIGHT_IMPLAUSIBLE: 'properties.georef.check.code.ORTHOGONAL_HEIGHT_IMPLAUSIBLE',
  SOURCES_DISAGREE: 'properties.georef.check.code.SOURCES_DISAGREE',
  IFC2X3_NO_EPSET: 'properties.georef.check.code.IFC2X3_NO_EPSET',
};

const SEVERITY_STYLE: Record<Severity, { icon: typeof Info; className: string; label: TranslationKey }> = {
  error: { icon: CircleAlert, className: 'text-destructive', label: 'properties.georef.check.severity.error' },
  warning: { icon: AlertTriangle, className: 'text-warn', label: 'properties.georef.check.severity.warning' },
  info: { icon: Info, className: 'text-muted-foreground', label: 'properties.georef.check.severity.info' },
};

/** `previous` keeps the last result on screen while an edit is re-checked, so the warning and the open list do not blink. */
type CheckState = { status: 'running'; previous?: GeorefDiagnosis | null } | { status: 'failed' } | { status: 'done'; diagnosis: GeorefDiagnosis | null };

/** Which panel notice already explains a finding, if any. */
function panelNotice(code: GeorefFindingCode, shown: GeorefDiagnosisSectionProps['shownInPanel']): TranslationKey | undefined {
  if (code === 'MAP_POSITION_APPLIED_TWICE' && shown.doubleGeoref) return 'properties.georef.check.shownInPanelDouble';
  if ((code === 'SCALE_UNIT_MISMATCH' || code === 'SCALE_DOES_NOT_BRIDGE_UNITS') && shown.scaleMismatch) return 'properties.georef.check.shownInPanelScale';
  return undefined;
}

function FindingRow({ item, notice, onApply }: { item: DiagnosisItem; notice?: TranslationKey; onApply?: () => void }) {
  const { t } = useTranslation();
  const style = SEVERITY_STYLE[item.finding.severity];
  const Icon = style.icon;
  return (
    <li className="px-3 py-1.5 flex items-start gap-1.5 text-xs leading-snug" data-finding-code={item.finding.code}>
      <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${style.className}`} aria-label={t(style.label)} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">{t(CODE_TITLE[item.finding.code])}</div>
        <div className="text-muted-foreground">{notice ? t(notice) : findingDetail(item.finding, t)}</div>
        {onApply && item.fix && (
          <div className="mt-1 flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onApply} className="h-6 px-2 text-xs">
              {t('properties.georef.check.applyFix')}
            </Button>
            <span className="text-muted-foreground">{item.fix.summary}</span>
          </div>
        )}
      </div>
    </li>
  );
}

export default function GeorefDiagnosisSection({ modelId, editable, mapUnitScale, shownInPanel }: GeorefDiagnosisSectionProps) {
  const { t, locale } = useTranslation();
  const store = useViewerStore((s) => s.models.get(modelId)?.ifcDataStore ?? null);
  const edits = useViewerStore((s) => s.georefMutations.get(modelId));
  const setGeorefFields = useViewerStore((s) => s.setGeorefFields);
  const view = useViewerStore((s) => s.mutationViews.get(modelId) ?? null);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  // Re-check when this session's site location changes, not on every other edit; mutationVersion because
  // the view's positional edits change in place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const siteKey = useMemo(() => (store ? JSON.stringify(editedSiteLocation(store, view) ?? null) : ''), [store, view, mutationVersion]);
  const [state, setState] = useState<CheckState>({ status: 'running' });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!store) return;
    let live = true;
    setState((prev) => ({ status: 'running', previous: prev.status === 'done' ? prev.diagnosis : prev.status === 'running' ? prev.previous : undefined }));
    diagnoseModelGeoreference(store, edits, mapUnitScale, useViewerStore.getState().mutationViews.get(modelId) ?? null).then(
      (diagnosis) => { if (live) setState({ status: 'done', diagnosis }); },
      (error) => {
        console.warn('[georef check] diagnosis failed', error);
        if (live) setState({ status: 'failed' });
      },
    );
    return () => { live = false; };
  }, [store, edits, mapUnitScale, modelId, siteKey]);

  const apply = useCallback((item: DiagnosisItem) => {
    if (!item.fix) return;
    const batch = newMutationBatchId();
    const { projectedCRS, mapConversion, site } = item.fix.writes;
    if (site && !writeSiteLocation(modelId, site, batch).ok) {
      toast.error(t('properties.georef.check.siteFixFailed'));
      return;
    }
    if (projectedCRS.length) setGeorefFields(modelId, 'projectedCRS', projectedCRS, batch);
    if (mapConversion.length) setGeorefFields(modelId, 'mapConversion', mapConversion, batch);
    posthog.capture('georeference_set', { method: 'diagnosis_fix', code: item.finding.code });
    toast.success(t('properties.georef.check.applied'));
  }, [modelId, setGeorefFields, t]);

  if (!store || (state.status === 'done' && !state.diagnosis)) return null;
  const diagnosis = state.status === 'done' ? state.diagnosis : state.status === 'running' ? state.previous ?? null : null;
  const outside = diagnosis?.items.find((item) => item.finding.code === 'OUTSIDE_CRS_AREA');
  const listed = diagnosis?.items.filter((item) => item !== outside) ?? [];
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const item of diagnosis?.items ?? []) counts[item.finding.severity]++;
  const summary = state.status === 'running' ? t('properties.georef.check.running')
    : state.status === 'failed' ? t('properties.georef.check.failed')
    : diagnosis?.items.length === 0 ? t('properties.georef.check.clean')
    : [
        counts.error && t('properties.georef.check.errors', { count: counts.error }),
        counts.warning && t('properties.georef.check.warnings', { count: counts.warning }),
        counts.info && t('properties.georef.check.notes', { count: counts.info }),
      ].filter(Boolean).join(', ');
  const applyFor = (item: DiagnosisItem, notice?: TranslationKey) =>
    editable && item.fix && notice !== 'properties.georef.check.shownInPanelDouble' ? () => apply(item) : undefined;

  return (
    <div className="border-b border-border">
      {outside && (
        <div className="px-3 py-2 bg-warn-surface text-xs text-warn" role="alert">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="leading-snug">
              <strong>{t('properties.georef.check.outsideAreaHeading', { code: String(outside.finding.evidence.epsg) })}</strong>{' '}
              {t('properties.georef.check.outsideAreaBody')}
              {diagnosis?.outsideAreaOfUse && <> {areaOfUseText(t, locale, diagnosis.outsideAreaOfUse)}</>}
            </span>
          </div>
          {editable && outside.fix && <ul><FindingRow item={outside} onApply={() => apply(outside)} /></ul>}
        </div>
      )}
      <Collapsible open={open && listed.length > 0} onOpenChange={setOpen} disabled={listed.length === 0}>
        <InspectorSectionTrigger
          className="disabled:hover:bg-transparent"
          icon={<Stethoscope className="h-3 w-3 text-muted-foreground shrink-0" />}
          title={t('properties.georef.check.heading')}
          trailing={<span className={INSPECTOR_COUNT} data-testid="georef-check-summary">{summary}</span>}
        />
        <CollapsibleContent>
          <ul className="divide-y divide-border border-t border-border">
            {listed.map((item, index) => {
              const notice = panelNotice(item.finding.code, shownInPanel);
              return <FindingRow key={`${item.finding.code}-${index}`} item={item} notice={notice} onApply={applyFor(item, notice)} />;
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
