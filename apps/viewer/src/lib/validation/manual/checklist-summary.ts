/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-group and overall counts for the manual-validation rings (#6401).
 *
 * The four buckets are disjoint and always sum to `total`: a warning is its
 * own bucket and is NOT a pass (the spec is explicit), and an item with no
 * verdict — including one that only carries a comment — is `unanswered`.
 * Answers whose item no longer exists in the template are ignored, so an
 * item deleted after it was answered cannot inflate a count.
 */

import type { ChecklistGroup, ChecklistTemplate, ManualAnswerMap } from './checklist.js';

export interface ManualCounts {
  total: number;
  pass: number;
  fail: number;
  warning: number;
  unanswered: number;
}

export const EMPTY_MANUAL_COUNTS: ManualCounts = Object.freeze({ total: 0, pass: 0, fail: 0, warning: 0, unanswered: 0 });

export function summarizeGroup(group: ChecklistGroup, answers: ManualAnswerMap): ManualCounts {
  const counts = { total: 0, pass: 0, fail: 0, warning: 0, unanswered: 0 };
  for (const item of group.items) {
    counts.total += 1;
    const status = answers[item.id]?.status ?? null;
    if (status === null) counts.unanswered += 1;
    else counts[status] += 1;
  }
  return counts;
}

export function sumCounts(parts: readonly ManualCounts[]): ManualCounts {
  const out = { total: 0, pass: 0, fail: 0, warning: 0, unanswered: 0 };
  for (const p of parts) {
    out.total += p.total;
    out.pass += p.pass;
    out.fail += p.fail;
    out.warning += p.warning;
    out.unanswered += p.unanswered;
  }
  return out;
}

export function summarizeChecklist(template: ChecklistTemplate, answers: ManualAnswerMap): { groups: Map<string, ManualCounts>; overall: ManualCounts } {
  const groups = new Map<string, ManualCounts>();
  for (const group of template.groups) groups.set(group.id, summarizeGroup(group, answers));
  return { groups, overall: sumCounts([...groups.values()]) };
}
