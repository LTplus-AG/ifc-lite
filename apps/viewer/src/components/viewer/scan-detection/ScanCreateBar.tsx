/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Create the accepted scan-to-BIM proposals (#6894) in the target IFC model,
 * as one undoable batch (`lib/scan-to-bim/create-elements.ts`). With no IFC
 * model loaded it offers a blank one, added beside the scan the way the
 * appearance capture panel adds its destination model.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useTranslation } from '@/i18n';
import { createBlankIfcFile } from '@/utils/createBlankIfc';
import { mutationDenialKey, mutationPermission } from '@/store/mutation-permission';
import { liveCreatedProposalIds, presentGlobalIds, visibleScanProposals, type ScanDetectionRun } from '@/store/slices/scanDetectionSlice';
import { createScanElements } from '@/lib/scan-to-bim/create-elements';
import { proposalTargetModel, scanFrameMoved, type DetectionDeps } from '@/lib/scan-to-bim/run-detection';

type Message = { kind: 'info' | 'error'; text: string } | null;

export interface ScanCreateBarProps {
  run: ScanDetectionRun;
  /** Test seam: where the scan is now; production asks the renderer. */
  deps?: DetectionDeps;
}

export function ScanCreateBar({ run, deps }: ScanCreateBarProps) {
  const { t } = useTranslation();
  const { addModel, loading } = useIfc();
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const decisions = useViewerStore((s) => s.scanProposalDecisions);
  const createdRecords = useViewerStore((s) => s.scanProposalCreated);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const target = proposalTargetModel(models, activeModelId);
  // Primitives only: a fresh object per render would loop the subscription.
  const denial = useViewerStore((s) => {
    if (!target) return null;
    const permission = mutationPermission(s, target.id);
    return permission.allowed ? null : permission.reason;
  });
  const filter = useViewerStore((s) => s.scanProposalFilter);
  const history = useViewerStore((s) => s.scanCreatedGlobalIds[run.sourceModelId]);
  const live = liveCreatedProposalIds(createdRecords, target, mutationViews, mutationVersion);
  const pending = (p: { id: string }) => decisions[p.id] === 'accepted' && !live.has(p.id);
  // Create acts on what the review shows: accepted, not yet created, and passing the filter.
  const accepted = visibleScanProposals(run, filter).filter(pending);
  const hiddenAccepted = run.result.proposals.proposals.filter(pending).length - accepted.length;
  // Elements this scan created earlier this session (an earlier run) that the target still holds.
  const thisRun = new Set(Object.values(createdRecords).map((r) => r.globalId));
  const earlier = target && history
    ? presentGlobalIds(target, mutationViews.get(target.id), history.filter((g) => !thisRun.has(g))).size
    : 0;
  const scanName = models.get(run.sourceModelId)?.name ?? run.sourceModelId;

  if (!target) {
    const createBlank = async () => {
      setBusy(true);
      setMessage({ kind: 'info', text: t('scanToBim.creatingBlank') });
      try {
        const modelId = await addModel(createBlankIfcFile({ projectName: 'Scan to BIM' }));
        setMessage(modelId ? null : { kind: 'error', text: t('scanToBim.blankFailed') });
      } catch (error) {
        setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="flex flex-col gap-1 border-t pt-1.5">
        <p className="text-2xs text-muted-foreground leading-tight">{t('scanToBim.needsModel')}</p>
        <Button size="sm" variant="outline" disabled={busy || loading} onClick={() => { void createBlank(); }}>{t('scanToBim.createBlank')}</Button>
        {message && <output className={message.kind === 'error' ? 'block text-2xs text-destructive' : 'block text-2xs text-muted-foreground'}>{message.text}</output>}
      </div>
    );
  }

  const create = () => {
    // The scan's placement lives in the renderer, so it is checked when it matters.
    if (scanFrameMoved(run, deps)) {
      setMessage({ kind: 'error', text: t('scanToBim.frameMoved') });
      return;
    }
    const state = useViewerStore.getState();
    const outcome = createScanElements({ modelId: target.id, proposals: accepted, scanName });
    if (!outcome.ok) {
      setMessage({ kind: 'error', text: t('scanToBim.createFailed', { message: outcome.reason }) });
      return;
    }
    state.recordScanProposalsCreated(target.id, outcome.created.map(({ proposalId, expressId, globalId }) => ({ proposalId, expressId, globalId })));
    setMessage({ kind: 'info', text: t('scanToBim.created', { count: outcome.created.length, model: target.name }) });
  };

  return (
    <div className="flex flex-col gap-1 border-t pt-1.5">
      <Button size="sm" disabled={accepted.length === 0 || denial !== null} onClick={create}>
        {accepted.length > 0 ? t('scanToBim.createCount', { count: accepted.length, model: target.name }) : t('scanToBim.create')}
      </Button>
      {accepted.length === 0 && <p className="text-2xs text-muted-foreground leading-tight">{t('scanToBim.createNone')}</p>}
      {hiddenAccepted > 0 && <p className="text-2xs text-muted-foreground leading-tight">{t('scanToBim.acceptedHidden', { count: hiddenAccepted })}</p>}
      {earlier > 0 && accepted.length > 0 && (
        <p className="text-2xs text-amber-600 leading-tight">{t('scanToBim.createdEarlier', { count: earlier, scan: scanName, model: target.name })}</p>
      )}
      {denial && accepted.length > 0 && (
        <p className="text-2xs text-amber-600 leading-tight">{t(mutationDenialKey(denial))}</p>
      )}
      {message && <output className={message.kind === 'error' ? 'block text-2xs text-destructive' : 'block text-2xs text-muted-foreground'}>{message.text}</output>}
    </div>
  );
}
