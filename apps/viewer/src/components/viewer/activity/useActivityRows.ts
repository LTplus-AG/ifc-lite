/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One list of user-initiated jobs for the tray (U02, #6925): the session
 * journal (loads, checks, exports, assistant requests, Flow runs) and the
 * durable BCF publication outbox, newest first with running jobs on top.
 */

import { useMemo } from 'react';
import { useActivityJournal, activityCanceller, type ActivityJob, type ActivityOutcome } from '@/lib/activity/activity-journal';
import { publicationActivity, type PublicationOutcome } from '@/lib/activity/publication-activity';
import { useBcfOutbox } from '@/lib/bcf-publication/outbox-store';
import type { AnalysisPanelId } from '@/lib/panels/registry';
import type { TranslationKey } from '@/i18n';
import type { ResultStatus } from '../result/status-labels';

export interface ActivityRow {
  id: string;
  titleKey: TranslationKey;
  subject?: string;
  status: ResultStatus;
  phase?: string;
  progress?: { done: number; total: number };
  /** Epoch ms of the last change. */
  at: number;
  detail?: string;
  detailKey?: TranslationKey;
  detailCount?: number;
  /** Stored outside the tab (IndexedDB) and recovered on reload. */
  persistent: boolean;
  cancel: (() => void) | null;
  panel?: AnalysisPanelId;
  publication?: { done: number; total: number };
}

const JOB_STATUS: Record<ActivityOutcome, ResultStatus> = {
  running: 'running', completed: 'complete', partial: 'partial', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted',
};
const PUBLICATION_STATUS: Record<PublicationOutcome, ResultStatus> = {
  running: 'running', queued: 'queued', completed: 'complete', partial: 'partial', failed: 'failed', uncertain: 'uncertain', blocked: 'blocked',
};

function jobRow(job: ActivityJob): ActivityRow {
  return {
    id: job.id, titleKey: job.title, status: JOB_STATUS[job.outcome],
    at: job.finishedAt ?? job.startedAt, persistent: false,
    cancel: job.outcome === 'running' ? activityCanceller(job.id) : null,
    ...(job.subject ? { subject: job.subject } : {}),
    ...(job.phase ? { phase: job.phase } : {}),
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.detail ? { detail: job.detail } : {}),
    ...(job.outcome === 'interrupted' ? { detailKey: 'activityTray.interruptedHint' as const } : job.detailKey ? { detailKey: job.detailKey } : {}),
    ...(job.panel ? { panel: job.panel } : {}),
  };
}

export function useActivityRows(): ActivityRow[] {
  const jobs = useActivityJournal((s) => s.jobs);
  const publications = useBcfOutbox((s) => s.entries);
  return useMemo(() => {
    const rows = jobs.map(jobRow);
    for (const record of publications) {
      const activity = publicationActivity(record);
      const parsed = Date.parse(activity.updatedAt);
      const detail = activity.attention > 0
        ? { detailKey: 'activityTray.publication.attention' as const, detailCount: activity.attention }
        : activity.failed > 0 ? { detailKey: 'activityTray.publication.failed' as const, detailCount: activity.failed } : {};
      rows.push({
        id: `publication:${activity.id}`, titleKey: 'activityTray.job.publication',
        subject: activity.subject, status: PUBLICATION_STATUS[activity.outcome], at: Number.isFinite(parsed) ? parsed : 0,
        persistent: true, cancel: null, panel: 'bcf', publication: { done: activity.done, total: activity.total }, ...detail,
      });
    }
    const live = (row: ActivityRow) => row.status === 'running' || row.status === 'queued';
    return rows.sort((a, b) => Number(live(b)) - Number(live(a)) || b.at - a.at);
  }, [jobs, publications]);
}
