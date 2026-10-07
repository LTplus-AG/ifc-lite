/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The review list of scan-to-BIM proposals (#6894): filter by class and
 * minimum confidence, accept or reject each proposal, or everything shown at
 * once. Decisions live in the store (`scanProposalDecisions`), so the overlay
 * and the later Create step read the same answer.
 */

import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { formatLocaleNumber, useTranslation, type TranslationKey } from '@/i18n';
import type { ProposalClass, ScanElementProposal } from '@ifc-lite/geometry/scan-proposals';
import { proposalTargetModel } from '@/lib/scan-to-bim/run-detection';
import { liveCreatedProposalIds, SCAN_PROPOSAL_CLASSES, visibleScanProposals, type ScanDetectionRun } from '@/store/slices/scanDetectionSlice';
import { SCAN_PROPOSAL_COLORS } from '@/lib/scan-to-bim/detection-overlay';
import { cn } from '@/lib/utils';

const CLASS_KEYS: Record<ProposalClass, TranslationKey> = {
  IfcWall: 'scanToBim.class.IfcWall',
  IfcSlab: 'scanToBim.class.IfcSlab',
  IfcColumn: 'scanToBim.class.IfcColumn',
  IfcPipeSegment: 'scanToBim.class.IfcPipeSegment',
  IfcFlowSegment: 'scanToBim.class.IfcFlowSegment',
};

const BASIS_KEYS: Record<ScanElementProposal['basis'], TranslationKey> = {
  pairedFaces: 'scanToBim.basis.pairedFaces',
  singleFace: 'scanToBim.basis.singleFace',
  floorCeilingPair: 'scanToBim.basis.floorCeilingPair',
  floor: 'scanToBim.basis.floor',
  ceiling: 'scanToBim.basis.ceiling',
  cylinder: 'scanToBim.basis.cylinder',
};

function swatch(cls: ProposalClass): string {
  const [r, g, b] = SCAN_PROPOSAL_COLORS[cls].map((v) => Math.round(v * 255));
  return `rgb(${r} ${g} ${b})`;
}

function polygonArea(outline: ReadonlyArray<readonly number[]>): number {
  let twice = 0;
  for (let i = 0; i < outline.length; i++) {
    const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

function useSize() {
  const { t, locale } = useTranslation();
  const m = (v: number) => formatLocaleNumber(locale, v, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (p: ScanElementProposal): string => {
    const g = p.geometry;
    switch (g.kind) {
      case 'wall':
        return t('scanToBim.size.wall', {
          length: m(Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1])), thickness: m(g.thicknessMetres), height: m(g.heightMetres),
        });
      case 'slab':
        return t('scanToBim.size.slab', { area: formatLocaleNumber(locale, polygonArea(g.outline), { maximumFractionDigits: 1 }), thickness: m(g.thicknessMetres) });
      case 'column':
        return t('scanToBim.size.column', { diameter: m(2 * g.radiusMetres), height: m(g.heightMetres) });
      case 'pipe':
        return t('scanToBim.size.pipe', { diameter: m(2 * g.radiusMetres), length: m(Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1], g.end[2] - g.start[2])) });
    }
  };
}

export function ScanProposalReview({ run }: { run: ScanDetectionRun }) {
  const { t, locale } = useTranslation();
  const decisions = useViewerStore((s) => s.scanProposalDecisions);
  const filter = useViewerStore((s) => s.scanProposalFilter);
  const decide = useViewerStore((s) => s.decideScanProposals);
  const setFilter = useViewerStore((s) => s.setScanProposalFilter);
  const createdRecords = useViewerStore((s) => s.scanProposalCreated);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const live = liveCreatedProposalIds(createdRecords, proposalTargetModel(models, activeModelId), mutationViews, mutationVersion);
  const size = useSize();
  const all = run.result.proposals.proposals;
  const present = SCAN_PROPOSAL_CLASSES.filter((c) => all.some((p) => p.ifcClass === c));
  const shown = visibleScanProposals(run, filter);
  const shownIds = shown.map((p) => p.id);
  const accepted = all.filter((p) => decisions[p.id] === 'accepted').length;
  const rejected = all.filter((p) => decisions[p.id] === 'rejected').length;
  const percent = (v: number) => formatLocaleNumber(locale, Math.round(v * 100));

  const toggleClass = (cls: ProposalClass, on: boolean) =>
    setFilter({ classes: on ? [...filter.classes, cls] : filter.classes.filter((c) => c !== cls) });

  return (
    <div className="flex flex-col gap-1.5">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-2xs text-muted-foreground">{t('scanToBim.filter.legend')}</legend>
        {present.map((cls) => (
          <label key={cls} className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="accent-teal-600" checked={filter.classes.includes(cls)} onChange={(e) => toggleClass(cls, e.target.checked)} />
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: swatch(cls) }} />
            {t('scanToBim.filter.class', { label: t(CLASS_KEYS[cls]), count: formatLocaleNumber(locale, all.filter((p) => p.ifcClass === cls).length) })}
          </label>
        ))}
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('scanToBim.filter.minConfidence')}</span>
          <input
            type="range" min={0} max={100} step={5} className="flex-1 h-1 accent-teal-600"
            value={Math.round(filter.minConfidence * 100)}
            onChange={(e) => setFilter({ minConfidence: Number(e.target.value) / 100 })}
          />
          <span className="w-10 text-right tabular-nums">{t('scanToBim.filter.minConfidenceValue', { value: percent(filter.minConfidence) })}</span>
        </label>
      </fieldset>
      <output className="block text-2xs text-muted-foreground">
        {t('scanToBim.decided', {
          accepted: formatLocaleNumber(locale, accepted), rejected: formatLocaleNumber(locale, rejected), pending: formatLocaleNumber(locale, all.length - accepted - rejected),
        })}
      </output>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" disabled={shown.length === 0} onClick={() => decide(shownIds, 'accepted')}>{t('scanToBim.acceptShown')}</Button>
        <Button size="sm" variant="outline" disabled={shown.length === 0} onClick={() => decide(shownIds, 'rejected')}>{t('scanToBim.rejectShown')}</Button>
        <Button size="sm" variant="ghost" disabled={shown.length === 0} onClick={() => decide(shownIds, null)}>{t('scanToBim.resetShown')}</Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-2xs text-muted-foreground">{t('scanToBim.empty')}</p>
      ) : (
        <ul aria-label={t('scanToBim.listLabel')} className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {shown.map((p) => {
            const decision = decisions[p.id];
            return (
              <li key={p.id} className={cn('flex flex-col gap-0.5 rounded border px-2 py-1', decision === 'rejected' && 'opacity-50')}>
                <div className="flex items-center gap-2 text-xs">
                  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: swatch(p.ifcClass) }} />
                  <span className="font-medium">{p.ifcClass}</span>
                  <span className="text-muted-foreground">{p.id}</span>
                  {live.has(p.id) && <span className="rounded bg-teal-600 px-1 text-2xs text-white">{t('scanToBim.createdBadge')}</span>}
                  <span className="ml-auto tabular-nums">{t('scanToBim.confidence', { value: percent(p.confidence) })}</span>
                </div>
                <span className="text-2xs text-muted-foreground">{size(p)}</span>
                <span className="text-2xs text-muted-foreground">{t(BASIS_KEYS[p.basis])}</span>
                <span className="text-2xs text-muted-foreground">
                  {t('scanToBim.fit', { rms: formatLocaleNumber(locale, p.fit.rmsMetres * 1000, { maximumFractionDigits: 1 }), points: formatLocaleNumber(locale, p.fit.inlierPoints) })}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm" variant={decision === 'accepted' ? 'default' : 'outline'} aria-pressed={decision === 'accepted'}
                    aria-label={t('scanToBim.acceptOne', { id: p.id })}
                    onClick={() => decide([p.id], decision === 'accepted' ? null : 'accepted')}
                  >
                    {t('scanToBim.accept')}
                  </Button>
                  <Button
                    size="sm" variant={decision === 'rejected' ? 'default' : 'outline'} aria-pressed={decision === 'rejected'}
                    aria-label={t('scanToBim.rejectOne', { id: p.id })}
                    onClick={() => decide([p.id], decision === 'rejected' ? null : 'rejected')}
                  >
                    {t('scanToBim.reject')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
