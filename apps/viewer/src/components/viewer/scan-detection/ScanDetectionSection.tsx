/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan to BIM (#6894), in the point cloud panel: "Detect elements" on a
 * loaded scan (the retained sample, or its section-box crop), progress and
 * Cancel while the worker runs, then the review list. Detection itself is
 * `lib/scan-to-bim/run-detection.ts`; this only renders and dispatches.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { activeSectionPlane } from '@/store/section-active';
import { formatLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import {
  cancelScanDetection,
  proposalSchema,
  proposalTargetModel,
  scanModels,
  startScanDetection,
  type DetectionDeps,
} from '@/lib/scan-to-bim/run-detection';
import { ScanProposalReview } from './ScanProposalReview';

const STAGE_KEYS: Record<'starting' | 'segmenting' | 'proposing', TranslationKey> = {
  starting: 'scanToBim.stage.starting',
  segmenting: 'scanToBim.stage.segmenting',
  proposing: 'scanToBim.stage.proposing',
};

/** Refusals `startScanDetection` reports by code. */
const ERROR_KEYS: Record<string, TranslationKey> = {
  noSample: 'scanToBim.error.noSample',
};

export interface ScanDetectionSectionProps {
  /** Test seam: the detector and cloud matrix; production uses the session worker and the renderer. */
  deps?: DetectionDeps;
}

export function ScanDetectionSection({ deps }: ScanDetectionSectionProps) {
  const { t, locale } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const status = useViewerStore((s) => s.scanDetectionStatus);
  const stage = useViewerStore((s) => s.scanDetectionStage);
  const error = useViewerStore((s) => s.scanDetectionError);
  const run = useViewerStore((s) => s.scanDetectionRun);
  const boxOn = useViewerStore((s) => !!activeSectionPlane(s)?.box);
  const scans = scanModels(models);
  const [chosen, setChosen] = useState<string | null>(null);
  if (scans.length === 0) return null;
  const sourceId = scans.some((m) => m.id === chosen) ? chosen! : scans[0].id;
  const target = proposalTargetModel(models, activeModelId);
  const running = status === 'running';
  const errorText = error && error in ERROR_KEYS ? t(ERROR_KEYS[error]) : t('scanToBim.error.failed', { message: error ?? '' });

  return (
    <section aria-labelledby="scan-to-bim-title" className="flex flex-col gap-1.5 border-t pt-2">
      <h3 id="scan-to-bim-title" className="text-2xs uppercase text-muted-foreground tracking-wider">{t('scanToBim.title')}</h3>
      <p className="text-2xs text-muted-foreground leading-tight">{t('scanToBim.intro')}</p>
      {scans.length > 1 && (
        <label className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{t('scanToBim.scanLabel')}</span>
          <select
            className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-xs"
            value={sourceId}
            onChange={(e) => setChosen(e.target.value)}
            disabled={running}
          >
            {scans.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}
      <p className="text-2xs leading-tight">
        {target ? t('scanToBim.target', { model: target.name, schema: proposalSchema(target) }) : t('scanToBim.noTarget')}
      </p>
      <p className="text-2xs text-muted-foreground leading-tight">{boxOn ? t('scanToBim.cropped') : t('scanToBim.whole')}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={running} onClick={() => { void startScanDetection(sourceId, deps); }}>
          {run ? t('scanToBim.detectAgain') : t('scanToBim.detect')}
        </Button>
        {running && (
          <Button size="sm" variant="outline" onClick={() => cancelScanDetection(deps)}>
            {t('scanToBim.cancel')}
          </Button>
        )}
      </div>
      {running && <output className="block text-2xs text-muted-foreground">{t(STAGE_KEYS[stage ?? 'starting'])}</output>}
      {status === 'failed' && <p role="alert" className="text-2xs text-destructive">{errorText}</p>}
      {run && (
        <>
          <p className="text-2xs text-muted-foreground leading-tight">
            {t('scanToBim.summary', {
              count: run.result.proposals.proposals.length,
              planes: formatLocaleNumber(locale, run.result.planes.length),
              cylinders: formatLocaleNumber(locale, run.result.cylinders.length),
              points: formatLocaleNumber(locale, run.pointCount),
            })}
          </p>
          {run.cropped && <p className="text-2xs text-muted-foreground leading-tight">{t('scanToBim.summaryCropped')}</p>}
          <ScanProposalReview run={run} />
        </>
      )}
    </section>
  );
}
