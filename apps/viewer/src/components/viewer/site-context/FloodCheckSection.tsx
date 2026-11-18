/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Surface runoff" in the Georeference panel, under "Site context": shown for
 * an IFC model placed in Switzerland. Two things, each only on a click:
 *
 * - the federal overland flow map (BAFU) draped on the loaded site-context
 *   terrain, in the publisher's legend colours;
 * - the screening check of `@ifc-lite/flood-check`, whose verdicts colour the
 *   checked elements and whose property sets show in the property panel.
 *
 * The section says what the check is (a screening against a published map,
 * not a flood simulation) before it is run, and shows the package's notes and
 * caveats with every result.
 */

import { useMemo, useRef, useState } from 'react';
import { Droplets, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { isFeatureEnabled } from '@/lib/features';
import { useViewerStore } from '@/store';
import { visibleSiteContextModels } from '@/store/slices/siteContextSlice';
import { MODEL_EDITED } from '@/store/slices/floodCheckSlice';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { GEOREF_FOCUS_CLASS, useGeorefSectionFocus } from '@/lib/site-context/georef-section-focus';
import { useSiteContextAnchor } from './SiteContextSection';
import { FloodCheckSummary } from './FloodCheckSummary';

const GUESS = 'guess';

/** The loaded, visible site-context terrain, if any: where the hazard map drapes (the legend reads the same). */
function useTerrain(): { modelId: string; hazard: boolean } | null {
  // Primitives only: a selector returning a fresh tuple fails the store's snapshot identity and loops.
  const terrain = (s: ReturnType<typeof useViewerStore.getState>) =>
    visibleSiteContextModels(s.siteContextModels, s.models).find(([, info]) => info.kind === 'terrain' && info.planBox);
  const modelId = useViewerStore((s) => terrain(s)?.[0] ?? null);
  const hazard = useViewerStore((s) => terrain(s)?.[1].hazard !== undefined);
  return modelId ? { modelId, hazard } : null;
}

const importRun = () => import('@/lib/flood-check/flood-check-run');
const importDrape = () => import('@/lib/site-context/site-context-imagery');

export function FloodCheckSection({ modelId }: { modelId: string }) {
  const { t } = useTranslation();
  const anchor = useSiteContextAnchor(modelId);
  const isIfc = useViewerStore((s) => (s.models.get(modelId)?.ifcDataStore ?? null) !== null && !s.siteContextModels.has(modelId));
  const run = useViewerStore((s) => (s.floodCheck?.modelId === modelId ? s.floodCheck : null));
  const otherRunning = useViewerStore((s) => s.floodCheck?.status === 'running' && s.floodCheck.modelId !== modelId);
  const models = useViewerStore((s) => s.models);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  // The live storeys, lowest first (renamed or added storeys read as they are now).
  const storeys = useMemo(() => modelStoreys({ models, mutationViews }, modelId), [models, mutationViews, modelId]);
  const terrain = useTerrain();
  const [groundStorey, setGroundStorey] = useState<string>(GUESS);
  const [draping, setDraping] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const requested = useGeorefSectionFocus(modelId, 'floodCheck', sectionRef, isIfc && anchor !== null);

  if (!isIfc || !anchor) return null;
  // Both fetch from geo.admin.ch: a host that switched third-party services off gets neither (as for the 3D world).
  if (!isFeatureEnabled('privacy.third-party')) return null;
  // A model the check cannot read stays quiet in the panel, but explains itself when the user asked for the check (#10603).
  if (!anchor.ok) {
    if (!requested) return null;
    return (
      <section ref={sectionRef} aria-labelledby={`flood-check-${modelId}`} className={`border-t border-border px-3 py-2 space-y-1 ${GEOREF_FOCUS_CLASS}`} data-testid="flood-check-section">
        <div className="flex items-center gap-2">
          <Droplets className="h-3 w-3 text-muted-foreground shrink-0" />
          <h4 id={`flood-check-${modelId}`} className="text-xs font-semibold text-foreground">{t('floodCheck.section.title')}</h4>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="flood-check-unavailable">{t('floodCheck.section.needsSwissGeoref')}</p>
      </section>
    );
  }
  const running = run?.status === 'running';

  const start = () => {
    void importRun().then(({ runViewerFloodCheck }) => runViewerFloodCheck({
      modelId, ...(groundStorey !== GUESS ? { groundStorey: Number(groundStorey) } : {}),
    })).catch((error: unknown) => {
      console.error('[flood-check] could not start:', error);
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };
  const toggleHazard = (on: boolean) => {
    if (!terrain) return;
    setDraping(true);
    void importDrape()
      .then(({ drapeSiteContextTerrain }) => drapeSiteContextTerrain(terrain.modelId, { hazard: on }))
      .catch((error: unknown) => {
        console.error('[flood-check] hazard map drape failed:', error);
        toast.error(t('floodCheck.section.hazardFailed', { reason: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => setDraping(false));
  };

  return (
    <section ref={sectionRef} aria-labelledby={`flood-check-${modelId}`} className={`border-t border-border px-3 py-2 space-y-2 ${GEOREF_FOCUS_CLASS}`} data-testid="flood-check-section">
      <div className="flex items-center gap-2">
        <Droplets className="h-3 w-3 text-muted-foreground shrink-0" />
        <h4 id={`flood-check-${modelId}`} className="text-xs font-semibold text-foreground">{t('floodCheck.section.title')}</h4>
      </div>
      <p className="text-xs text-muted-foreground">{t('floodCheck.section.intro')}</p>
      <p className="text-xs text-warn" data-testid="flood-check-screening-only">{t('floodCheck.section.screeningOnly')}</p>

      <div className="space-y-1">
        <Checkbox
          checked={terrain?.hazard ?? false} disabled={!terrain || draping}
          onCheckedChange={toggleHazard} label={t('floodCheck.section.showHazard')}
        />
        {!terrain && <p className="text-2xs text-muted-foreground">{t('floodCheck.section.hazardNeedsTerrain')}</p>}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground" htmlFor={`flood-ground-${modelId}`}>{t('floodCheck.section.groundStorey')}</label>
        <Select value={groundStorey} onValueChange={setGroundStorey} disabled={running}>
          <SelectTrigger id={`flood-ground-${modelId}`} className="h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={GUESS}>{t('floodCheck.section.groundStoreyGuess')}</SelectItem>
            {storeys.map((storey) => <SelectItem key={storey.expressId} value={String(storey.expressId)}>{storey.name || `#${storey.expressId}`}</SelectItem>)}
          </SelectContent>
        </Select>
        {groundStorey === GUESS && <p className="text-2xs text-muted-foreground">{t('floodCheck.section.groundStoreyGuessNote')}</p>}
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={running || otherRunning} onClick={start} data-testid="flood-check-run">
          <Droplets className="h-3 w-3" />{t(run?.status === 'done' ? 'floodCheck.section.rerun' : 'floodCheck.section.run')}
        </Button>
        {running && (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => useViewerStore.getState().cancelFloodCheck()}>
            <X className="h-3 w-3" />{t('floodCheck.section.cancel')}
          </Button>
        )}
      </div>
      {running && <output className="block text-xs text-muted-foreground">{t('floodCheck.section.running')}</output>}
      {run?.status === 'error' && run.error && (
        <p role="alert" className="text-xs text-error" data-testid="flood-check-error">
          {run.error.code === MODEL_EDITED ? t('floodCheck.section.modelEdited')
            : run.error.code ? t('floodCheck.section.refused', { reason: run.error.message }) : run.error.message}
        </p>
      )}
      {run?.status === 'done' && run.data && <FloodCheckSummary data={run.data} />}
      <p className="text-2xs text-muted-foreground">{t('siteContext.section.privacy')}</p>
    </section>
  );
}
