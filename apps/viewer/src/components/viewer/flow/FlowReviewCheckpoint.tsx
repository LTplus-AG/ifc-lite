/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The review card of a Flow run paused at an AI node's proposal (#6923).
 *
 * It shows exactly what was saved in the checkpoint (every row of the
 * proposal and its coverage), and the only way forward is an explicit
 * Approve, which names the digest of what is on screen and resumes the run
 * from it; Reject ends it. A resume that is refused (graph, inputs or models
 * changed) or that did not finish says so and offers no retry of the same
 * proposal: the graph must run again for a new one.
 */

import { useEffect, useId } from 'react';
import { type FlowDocument } from '@ifc-lite/flow';
import { checkpointProposal, type FlowCheckpoint } from '@ifc-lite/flow/checkpoint';
import { registerEnglish, type TranslationKey } from '@/i18n';
import { flowReviewEn } from '@/i18n/catalogues/flow-review.en';
import { useTranslation } from '@/i18n/useTranslation';
import { useViewerStore } from '@/store';
import { approveReview, loadGraphReview, rejectReview, useFlowReview, type ReviewProblem } from '@/lib/flow/review-session';
import { FlowValuePreview } from './FlowValuePreview';

registerEnglish(flowReviewEn);

const button = 'rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50';
/** Every row of a proposal is reviewable; past this the card scrolls rather than truncating. */
const REVIEW_ROWS = 500;

const STATE_KEY: Record<FlowCheckpoint['state'], TranslationKey> = {
  prepared: 'flowReview.state.prepared', reviewed: 'flowReview.state.reviewed', applying: 'flowReview.state.applying',
  completed: 'flowReview.state.completed', 'partially-committed': 'flowReview.state.partial', rejected: 'flowReview.state.rejected',
};
const COVERAGE_KEY: Record<string, TranslationKey> = {
  'ai.classify': 'flowReview.coverage.classify', 'ai.summarize': 'flowReview.coverage.summarize', 'ai.extract': 'flowReview.coverage.extract',
};

function problemText(t: (key: TranslationKey, params?: Record<string, string | number>) => string, problem: ReviewProblem): string {
  if (problem.kind === 'not-saved') return t('flowReview.notSaved', { reason: problem.message });
  if (problem.code === 'graph-changed' || problem.code === 'sources-changed') return t(`flowReview.refused.${problem.code}`);
  return t('flowReview.refused.other', { reason: problem.message });
}

export function FlowReviewCheckpoint({ doc, onResume }: {
  doc: FlowDocument;
  /** Resume the run from the approved checkpoint with the Player values the paused run used. */
  onResume: (checkpoint: FlowCheckpoint, values: Record<string, unknown>) => Promise<void>;
}) {
  const { t, locale } = useTranslation();
  const headingId = useId();
  const { checkpoint, values, busy, problem } = useFlowReview();
  const running = useViewerStore((s) => s.flowRunning);

  useEffect(() => {
    loadGraphReview(doc.id).catch((error: unknown) => {
      useFlowReview.setState({ problem: { kind: 'not-saved', message: error instanceof Error ? error.message : String(error) } });
    });
  }, [doc.id]);

  const shown = checkpoint?.graphId === doc.id ? checkpoint : null;
  if (!shown && !problem) return null;

  // Approval names the digest of the proposal on screen; an approved one whose
  // resume could not start (a failed preflight) can be resumed again.
  const approve = async () => {
    if (!shown) return;
    const approved = shown.state === 'reviewed' ? shown : await approveReview(shown.proposalDigest);
    if (approved) await onResume(approved, values);
  };
  const typeOf = (nodeId: string) => doc.nodes.find((n) => n.id === nodeId)?.type ?? '';
  const proposal = shown ? [...checkpointProposal(shown)] : [];

  return (
    <section aria-labelledby={headingId} className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border px-3 py-2 text-2xs" data-flow-review>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-xs font-medium">{t('flowReview.title')}</h3>
        {shown && <span className="font-mono text-muted-foreground">{t('flowReview.digest', { digest: shown.proposalDigest.slice(0, 12) })}</span>}
        {shown && <span className="text-muted-foreground">{t('flowReview.created', { time: new Date(shown.createdAt).toLocaleTimeString(locale) })}</span>}
      </div>
      {shown && (
        <p className="mt-1">{t('flowReview.paused', { count: shown.reviewNodes.length, nodes: shown.reviewNodes.join(', ') })}</p>
      )}
      {proposal.map(([nodeId, ports]) => {
        const coverage = ports.get('coverage');
        const coverageKey = COVERAGE_KEY[typeOf(nodeId)];
        return (
          <div key={nodeId} className="mt-2 space-y-1" data-flow-review-node={nodeId}>
            <h4 className="font-medium">{t('flowReview.node', { node: nodeId, type: typeOf(nodeId) })}</h4>
            {coverage?.kind === 'item' && coverageKey && (
              <p className="text-muted-foreground">{t(coverageKey, coverage.value as Record<string, string | number>)}</p>
            )}
            {[...ports].filter(([port]) => port !== 'coverage').map(([port, data]) => (
              <FlowValuePreview key={port} data={data} limit={REVIEW_ROWS} />
            ))}
          </div>
        );
      })}
      {shown && <output className="mt-2 block">{t(STATE_KEY[shown.state], { reason: shown.outcome?.message ?? '' })}</output>}
      {problem && <p role="alert" className="mt-1 text-red-400">{problemText(t, problem)}</p>}
      {(shown?.state === 'prepared' || shown?.state === 'reviewed') && (
        <div className="mt-2 flex gap-2">
          <button type="button" className={`${button} border-[#7aa2f7] text-[#7aa2f7]`} disabled={busy || running} onClick={() => void approve()}>
            {t(shown.state === 'prepared' ? 'flowReview.approve' : 'flowReview.resume')}
          </button>
          {shown.state === 'prepared' && <button type="button" className={button} disabled={busy || running} onClick={() => void rejectReview()}>{t('flowReview.reject')}</button>}
        </div>
      )}
      {shown && shown.state !== 'prepared' && shown.state !== 'applying' && shown.state !== 'reviewed' && (
        <button type="button" className={`${button} mt-2`} onClick={() => useFlowReview.setState({ checkpoint: null, problem: null })}>{t('flowReview.dismiss')}</button>
      )}
    </section>
  );
}
