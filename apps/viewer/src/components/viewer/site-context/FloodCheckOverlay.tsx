/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The flood check in the viewport: the verdict colours on the checked
 * elements (one overlay layer, through the overlay compositor like every other
 * colouring owner) and two legends above the attribution line, one for the
 * overland flow map while it is draped and one for the verdict colours while
 * they are shown. Each legend carries its own short caveat, so a screenshot of
 * the viewport never shows the map or the colours without it.
 *
 * Mounted once, with the viewport overlays, so the colours survive the panel
 * closing.
 */

import { useEffect } from 'react';
import { BAFU_CLASSES, BAFU_LEGEND } from '@ifc-lite/flood-check';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { visibleSiteContextModels } from '@/store/slices/siteContextSlice';
import { floodVerdictOverrides, localized, OUTCOME_LABEL_KEY, OUTCOME_ORDER, outcomeCss } from '@/lib/flood-check/flood-verdicts';

export const FLOOD_OVERLAY_LAYER_ID = 'flood-check';
/** Above lens colouring (50) and animation (100), below Gantt selection (200) and user isolation (300). */
const FLOOD_OVERLAY_PRIORITY = 150;

/** Registers the verdict colours while a result is shown; removes them otherwise. */
export function useFloodVerdictColours(): void {
  const run = useViewerStore((s) => s.floodCheck);
  const shown = useViewerStore((s) => s.floodColoursShown);
  const toGlobalId = useViewerStore((s) => s.toGlobalId);
  useEffect(() => {
    const state = useViewerStore.getState();
    const data = run?.status === 'done' ? run.data : null;
    if (!run || !data || !shown || !state.models.has(run.modelId)) {
      state.removeOverlayLayer(FLOOD_OVERLAY_LAYER_ID);
      return;
    }
    const colorOverrides = floodVerdictOverrides(data.result, (expressId) => toGlobalId(run.modelId, expressId));
    state.registerOverlayLayer({ id: FLOOD_OVERLAY_LAYER_ID, priority: FLOOD_OVERLAY_PRIORITY, hiddenIds: null, colorOverrides });
    return () => useViewerStore.getState().removeOverlayLayer(FLOOD_OVERLAY_LAYER_ID);
  }, [run, shown, toGlobalId]);
}

function Swatch({ colour }: { colour: string }) {
  return <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-border" style={{ background: colour }} />;
}

/** A model edited after it was checked no longer matches its verdicts: drop them (the panel says why). */
export function useFloodCheckInvalidation(): void {
  const edited = useViewerStore((s) => {
    const run = s.floodCheck;
    if (!run || run.status === 'error') return false;
    return s.georefMutations.has(run.modelId) || (s.mutationViews.get(run.modelId)?.hasChanges() ?? false);
  });
  useEffect(() => { if (edited) useViewerStore.getState().invalidateFloodCheck(); }, [edited]);
}

export function FloodCheckOverlay() {
  useFloodVerdictColours();
  useFloodCheckInvalidation();
  const { t, locale } = useTranslation();
  const hazardShown = useViewerStore((s) => visibleSiteContextModels(s.siteContextModels, s.models).some(([, info]) => info.hazard !== undefined));
  const run = useViewerStore((s) => s.floodCheck);
  const coloursShown = useViewerStore((s) => s.floodColoursShown);
  const verdicts = run?.status === 'done' && run.data && coloursShown ? run.data.result.summary : null;
  if (!hazardShown && !verdicts) return null;
  return (
    <div className="pointer-events-none absolute bottom-8 right-2 flex max-w-72 flex-col gap-1.5" data-testid="flood-check-legends">
      {hazardShown && (
        <section aria-label={t('floodCheck.legend.hazardTitle')} className="rounded bg-background/80 px-2 py-1.5 text-2xs text-foreground backdrop-blur-sm" data-testid="flood-hazard-legend">
          <p className="font-semibold">{t('floodCheck.legend.hazardTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {BAFU_LEGEND.filter((entry) => entry.classId !== 'glacier').map((entry) => {
              const definition = BAFU_CLASSES.find((c) => c.id === entry.classId);
              return (
                <li key={entry.classId} className="flex items-center gap-1.5">
                  <Swatch colour={`rgb(${entry.rgb.join(' ')})`} />
                  <span>{definition ? localized(definition.label, locale) : entry.classId}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-muted-foreground">{t('floodCheck.legend.hazardCaveat')}</p>
        </section>
      )}
      {verdicts && (
        <section aria-label={t('floodCheck.legend.verdictTitle')} className="rounded bg-background/80 px-2 py-1.5 text-2xs text-foreground backdrop-blur-sm" data-testid="flood-verdict-legend">
          <p className="font-semibold">{t('floodCheck.legend.verdictTitle')}</p>
          <ul className="mt-1 space-y-0.5">
            {OUTCOME_ORDER.filter((outcome) => verdicts[outcome] > 0).map((outcome) => (
              <li key={outcome} className="flex items-center gap-1.5">
                <Swatch colour={outcomeCss(outcome)} />
                <span>{t(OUTCOME_LABEL_KEY[outcome])}</span>
                <span className="ml-auto pl-2 font-mono">{verdicts[outcome]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">{t('floodCheck.legend.verdictCaveat')}</p>
        </section>
      )}
    </div>
  );
}
