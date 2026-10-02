/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ValidationReportSnapshot } from '../reports/history.js';
import { validateManualReportBlock } from '../../document/manual-report-types.js';
import type { DocumentValidationError } from '../../document/types.js';
import {
  MAX_ANSWER_COMMENT, MAX_CHECKLIST_TEXT, MAX_CHECKLIST_DESCRIPTION,
  parseChecklistFile, type ManualAnswerMap, type ChecklistTemplate,
} from './checklist.js';
import { MAX_ANSWERS, isMeaningfulAnswer, type ManualAnswersByModel } from './persistence.js';
import type { ManualModelOption } from './manual-model.js';

export type ManualReportReuse =
  | { ok: true; template: ChecklistTemplate; answers: ManualAnswersByModel; preferredModelFingerprint: string }
  | { ok: false; reason: 'invalid' | 'noIdentity' | 'modelNotLoaded' };

/** Recover a bounded editable copy of recorded manual evidence (#6611).
 * The snapshot's fingerprint binds answers; scope labels and active peers
 * cannot replace it. Its recording date is a fallback, not an item edit date.
 * Shared by the UI and store action so neither can bypass the refusal rules. */
export function manualReportReuse(snapshot: ValidationReportSnapshot, models: readonly Pick<ManualModelOption, 'fingerprint'>[]): ManualReportReuse {
  if (snapshot.kind !== 'manual-report' || !snapshot.id || !Number.isFinite(Date.parse(snapshot.generatedAt))) return { ok: false, reason: 'invalid' };
  const errors: DocumentValidationError[] = [];
  validateManualReportBlock({ ...snapshot }, 'snapshot', errors);
  if (errors.length) return { ok: false, reason: 'invalid' };
  const fingerprint = snapshot.modelFingerprint;
  if (!fingerprint?.trim()) return { ok: false, reason: 'noIdentity' };
  if (!models.some(model => model.fingerprint === fingerprint)) return { ok: false, reason: 'modelNotLoaded' };
  // Canonical template/answer parsers cap text. Refuse an oversized imported
  // snapshot here rather than silently shorten the evidence being recovered.
  if (snapshot.checklistName.length > MAX_CHECKLIST_TEXT || snapshot.groups.some(group =>
    group.name.length > MAX_CHECKLIST_TEXT || group.items.some(item =>
      item.text.length > MAX_CHECKLIST_TEXT || (item.description?.length ?? 0) > MAX_CHECKLIST_DESCRIPTION
      || (item.comment?.length ?? 0) > MAX_ANSWER_COMMENT))) return { ok: false, reason: 'invalid' };
  const parsed = parseChecklistFile({ version: 1, name: snapshot.checklistName, groups: snapshot.groups.map(group => ({
    id: group.id, name: group.name, items: group.items.map(item => ({
      id: item.id, text: item.text, ...(item.description !== undefined ? { description: item.description } : {}),
    })),
  })) });
  if (!parsed.ok) return { ok: false, reason: 'invalid' };
  const updatedAt = Date.parse(snapshot.generatedAt);
  const entries: Array<[string, ManualAnswerMap[string]]> = snapshot.groups.flatMap(group => group.items.flatMap(item => {
    const answer = { status: item.status, updatedAt, ...(item.comment !== undefined ? { comment: item.comment } : {}) };
    return isMeaningfulAnswer(answer) ? [[item.id, answer] as [string, ManualAnswerMap[string]]] : [];
  }));
  if (entries.length > MAX_ANSWERS) return { ok: false, reason: 'invalid' };
  return { ok: true, template: parsed.template, answers: Object.fromEntries([[fingerprint, Object.fromEntries(entries)]]), preferredModelFingerprint: fingerprint };
}
