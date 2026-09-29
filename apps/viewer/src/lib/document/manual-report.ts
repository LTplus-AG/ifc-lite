/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A manual report block's content (#6401): a frozen snapshot of the working
 * checklist and one model's answers, taken when the block is added or
 * refreshed. The counts come from the same `summarizeChecklist` the panel's
 * rings use, so the document and the panel cannot disagree about what was
 * recorded.
 */

import type { ChecklistTemplate, ManualAnswerMap } from '../validation/manual/checklist.js';
import { summarizeChecklist, EMPTY_MANUAL_COUNTS } from '../validation/manual/checklist-summary.js';
import type { ManualReportBlock, ManualReportItem } from './manual-report-types.js';

export interface ManualReportSource {
  checklist: ChecklistTemplate;
  answers: ManualAnswerMap;
  /** The model the answers belong to, for the heading. */
  modelName?: string;
  /** That model's fingerprint (its answers' key), which Refresh re-reads. */
  modelFingerprint?: string | null;
  now?: Date;
}

export function manualReportBlockFromChecklist(source: ManualReportSource, id: string): ManualReportBlock {
  const { checklist, answers } = source;
  const summary = summarizeChecklist(checklist, answers);
  return {
    kind: 'manual-report',
    id,
    checklistName: checklist.name,
    ...(source.modelName ? { modelName: source.modelName } : {}),
    ...(source.modelFingerprint ? { modelFingerprint: source.modelFingerprint } : {}),
    generatedAt: (source.now ?? new Date()).toISOString(),
    summary: { ...summary.overall },
    groups: checklist.groups.map((group) => ({
      id: group.id,
      name: group.name,
      counts: { ...(summary.groups.get(group.id) ?? EMPTY_MANUAL_COUNTS) },
      items: group.items.map((item): ManualReportItem => {
        const answer = answers[item.id];
        const out: ManualReportItem = { id: item.id, text: item.text, status: answer?.status ?? null };
        if (item.description) out.description = item.description;
        if (answer?.comment?.trim()) out.comment = answer.comment;
        return out;
      }),
    })),
  };
}

/** A block with no content yet, for when there is no checklist to snapshot. */
export function emptyManualReportBlock(id: string, now: Date = new Date()): ManualReportBlock {
  return { kind: 'manual-report', id, checklistName: '', generatedAt: now.toISOString(), summary: { ...EMPTY_MANUAL_COUNTS }, groups: [] };
}
