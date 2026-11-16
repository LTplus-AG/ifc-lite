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

import { useMemo, useState } from 'react';
import { Droplets, X } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { SiteContextModelInfo } from '@/store/slices/siteContextSlice';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useSiteContextAnchor } from './SiteContextSection';
import { FloodCheckSummary } from './FloodCheckSummary';

const GUESS = 'guess';

/** The model's storeys, in file order, for the ground-storey choice. */
function useStoreys(modelId: string): Array<{ id: number; name: string }> {
  const dataStore = useViewerStore((s) => s.models.get(modelId)?.ifcDataStore ?? null);
  return useMemo(() => {
    if (!dataStore) return [];
    return [...(dataStore.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [])].map((id) => ({ id, name: dataStore.entities.getName(id) || `#${id}` }));
  }, [dataStore]);
}

/** The loaded site-context terrain, if any: where the hazard map drapes. */
function terrainOf(state: ReturnType<typeof useViewerStore.getState>): [string, SiteContextModelInfo] | null {
  for (const [modelId, info] of state.siteContextModels) {
    if (info.kind === 'terrain' && info.planBox && state.models.has(modelId)) return [modelId, info];
  }
  return null;
}

function useTerrain(): { modelId: string; hazard: boolean } | null {
  const modelId = useViewerStore((s) => terrainOf(s)?.[0] ?? null);
  const hazard = useViewerStore((s) => terrainOf(s)?.[1].hazard !== undefined);
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
  const storeys = useStoreys(modelId);
  const terrain = useTerrain();
  const [groundStorey, setGroundStorey] = useState<string>(GUESS);
  const [draping, setDraping] = useState(false);

  if (!isIfc || !anchor?.ok) return null;
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
    const record = useViewerStore.getState().siteContextModels.get(terrain.modelId);
    setDraping(true);
    void importDrape()
      .then(({ drapeSiteContextTerrain }) => drapeSiteContextTerrain(terrain.modelId, { imagery: record?.imagery !== undefined, hazard: on }))
      .catch((error: unknown) => {
        console.error('[flood-check] hazard map drape failed:', error);
        toast.error(t('floodCheck.section.hazardFailed', { reason: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => setDraping(false));
  };

  return (
    <section aria-labelledby={`flood-check-${modelId}`} className="border-t border-border px-3 py-2 space-y-2" data-testid="flood-check-section">
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
            {storeys.map((storey) => <SelectItem key={storey.id} value={String(storey.id)}>{storey.name}</SelectItem>)}
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
          {run.error.code ? t('floodCheck.section.refused', { reason: run.error.message }) : run.error.message}
        </p>
      )}
      {run?.status === 'done' && run.data && <FloodCheckSummary data={run.data} />}
      <p className="text-2xs text-muted-foreground">{t('siteContext.section.privacy')}</p>
    </section>
  );
}
