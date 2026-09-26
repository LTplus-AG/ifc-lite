/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publish-as-layer (#5167 Phase 2 leftover): the last successful run's
 * writes, through the SAME `publishViewerDraft` the Layers panel's Draft
 * section uses — not a parallel publish path — carrying graph provenance
 * (`author.tool = "flow:<graphId>"`, `author.session = <graphId>`, and the
 * tracking keys of the nodes that wrote in the intent line).
 *
 * "This run's" mutations are those timestamped inside the run's closed window
 * (`flowLastRunWindow`, set by `useFlowRunner`); there is no per-mutation batch
 * label to filter on otherwise (`pendingCompositionMutations` reads the
 * federated composition's undo stacks, not a per-run buffer).
 */

import { useCallback, useMemo, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import type { NodeRegistry, RunResult } from '@ifc-lite/flow';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { toast } from '@/components/ui/toast';
import { getBrowserLayerStore, DEFAULT_LOCAL_REF } from '@/lib/layers/browser-store';
import { publishViewerDraft } from '@/lib/layers/publish';
import { pendingCompositionMutations } from '@/lib/layers/pending';
import { flowPublishEligibility, flowPublishIntent, writingNodes, FLOW_PUBLISH_AUTHOR_KIND, mutationsInRun, countPendingOutsideRun } from '@/lib/flow/publish-provenance';

const AUTHOR_STORAGE_KEY = 'ifc-lite:layer-author';

function storedAuthor(): string {
  if (typeof window === 'undefined') return 'viewer-user';
  // Blocked storage throws (e.g. a SecurityError); an unreadable author name
  // must not fail the whole publish.
  try {
    return window.localStorage.getItem(AUTHOR_STORAGE_KEY) || 'viewer-user';
  } catch {
    return 'viewer-user';
  }
}

const button = 'inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50';

export interface FlowPublishButtonProps {
  readonly registry: NodeRegistry<unknown>;
  readonly lastRun: RunResult | null;
  readonly lastError: string | null;
}

export function FlowPublishButton({ registry, lastRun, lastError }: FlowPublishButtonProps) {
  const { t } = useTranslation();
  const { addIfcxOverlays } = useIfc();
  const runWindow = useViewerStore((s) => s.flowLastRunWindow);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const [busy, setBusy] = useState(false);

  // Re-counted on every mutation, so an edit made after the run disables
  // Publish until it is published or undone.
  const { pendingOutsideRun, pendingInRun } = useMemo(() => {
    const state = useViewerStore.getState();
    const all = [...state.undoStacks.values()].flat();
    return {
      pendingOutsideRun: countPendingOutsideRun(all, runWindow, state.georefMutations.size),
      pendingInRun: runWindow ? mutationsInRun(all, runWindow).length : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutationVersion is the change signal for the store read above
  }, [runWindow, mutationVersion]);
  const eligibility = useMemo(
    () => flowPublishEligibility(lastRun, lastError, pendingOutsideRun, pendingInRun),
    [lastRun, lastError, pendingOutsideRun, pendingInRun],
  );
  // Provenance comes from the graph AS RUN (`runWindow.doc`), never the working
  // copy: an edit after the run, such as a changed tracking key, must not be
  // credited with writes the previous version made (#5380 review).
  const runDoc = runWindow?.doc ?? null;
  const nodes = useMemo(() => (lastRun && runDoc && eligibility.canPublish ? writingNodes(runDoc, registry, lastRun) : []), [runDoc, registry, lastRun, eligibility.canPublish]);

  const publish = useCallback(async () => {
    if (!eligibility.canPublish || runWindow === null) return;
    const doc = runWindow.doc;
    setBusy(true);
    /** Edits pending right now that this run did not make. */
    const outsideNow = (): number => {
      const now = useViewerStore.getState();
      return countPendingOutsideRun([...now.undoStacks.values()].flat(), runWindow, now.georefMutations.size);
    };
    try {
      const store = await getBrowserLayerStore();
      // Re-checked AFTER the await: an edit made while the layer store opened
      // would otherwise be swept up by the clear below (#5380 review).
      if (outsideNow() > 0) {
        toast.error(t('flowPanel.publish.reason.otherEdits'));
        return;
      }
      const state = useViewerStore.getState();
      const idToPath = new Map<number, string>();
      for (const [path, id] of state.layerStackPathToId ?? []) idToPath.set(id, path);
      const mutations = mutationsInRun(pendingCompositionMutations(), runWindow);
      const result = publishViewerDraft({
        store,
        stackFiles: state.layerStack.map((e) => e.file),
        mutations,
        pathOf: (expressId) => idToPath.get(expressId),
        intent: flowPublishIntent(doc, nodes),
        authorPrincipal: storedAuthor(),
        refName: DEFAULT_LOCAL_REF,
        authorKind: FLOW_PUBLISH_AUTHOR_KIND,
        authorTool: `flow:${doc.id}`,
        authorSession: doc.id,
      });

      // Load the published layer FIRST, and clear the pending edits only once
      // it is in place: clearing first meant a failed load left the user with
      // neither their edits nor the layer showing them.
      const json = JSON.stringify(result.file);
      const fileName = `${doc.name.slice(0, 40).replace(/[^\w-]+/g, '-') || 'flow'}.ifcx`;
      await addIfcxOverlays([new File([json], fileName, { type: 'application/json' })]);
      if (outsideNow() > 0) {
        // Someone edited during the load. Clearing now would destroy that
        // edit, so keep everything pending and say why.
        toast.error(t('flowPanel.publish.keptPending'));
        return;
      }
      useViewerStore.getState().clearAllMutations();
      toast.success(t('flowPanel.publish.success', { layerId: result.layerId.slice(0, 15), ref: DEFAULT_LOCAL_REF }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [eligibility.canPublish, runWindow, nodes, addIfcxOverlays, t]);

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        className={`${button} border-[#9ece6a] text-[#9ece6a]`}
        disabled={!eligibility.canPublish || busy}
        title={eligibility.reason ? t(eligibility.reason) : t('flowPanel.publish.hint')}
        onClick={() => void publish()}
      >
        <UploadCloud className="h-3 w-3" aria-hidden="true" />{busy ? t('flowPanel.publish.publishing') : t('flowPanel.publish.publish')}
      </button>
      {eligibility.reason && <span className="text-2xs text-muted-foreground">{t(eligibility.reason)}</span>}
    </div>
  );
}
