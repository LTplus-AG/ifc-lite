/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * localStorage persistence for manual validation (#6401), following the
 * clash-review pattern (`lib/clash/persistence.ts`, #1468):
 *
 * - ANSWERS are keyed by the model's source fingerprint, then by item id,
 *   so a verdict re-attaches when the same file is loaded again and never
 *   leaks onto a different model. Default-state answers (no verdict, no
 *   comment) are pruned on save so storage holds only real decisions.
 * - The WORKING CHECKLIST (the template being filled in or edited) is kept
 *   too, so a reload does not strand the answers without their questions.
 *   The `.checklist.json` file stays the shareable source of truth.
 *
 * A read that fails never licenses destroying what is stored: the value is
 * moved aside (`preserveUnreadableEntry`), or, if that fails too, writes to
 * the key are refused until a later clean read.
 */

import {
  MANUAL_VERDICTS,
  MAX_ANSWER_COMMENT,
  parseChecklistFile,
  serializeChecklist,
  type ChecklistTemplate,
  type ManualAnswer,
  type ManualAnswerMap,
  type ManualVerdict,
} from './checklist.js';
import { optionalLocalStorage, preserveUnreadableEntry } from '../../storage/unreadable-entry.js';

const ANSWERS_KEY = 'ifc-lite:validation:manual-answers';
const CHECKLIST_KEY = 'ifc-lite:validation:manual-checklist';
const SCHEMA_VERSION = 1;
/** Cap on stored answers across every model, so the origin's quota survives. */
const MAX_ANSWERS = 20_000;

export type ManualSaveResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'serialize' | 'too_many' | 'unreadable' };

/** fingerprint → itemId → answer. */
export type ManualAnswersByModel = Readonly<Record<string, ManualAnswerMap>>;

const unwritableKeys = new Set<string>();

function onReadFailure(key: string, cause: unknown): void {
  if (preserveUnreadableEntry(optionalLocalStorage(), key, cause)) unwritableKeys.delete(key);
  else unwritableKeys.add(key);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isVerdict(v: unknown): v is ManualVerdict {
  return typeof v === 'string' && (MANUAL_VERDICTS as readonly string[]).includes(v);
}

/** An answer worth keeping: a verdict or a non-empty comment. */
export function isMeaningfulAnswer(answer: ManualAnswer): boolean {
  return answer.status !== null || (answer.comment ?? '').trim().length > 0;
}

/** Normalize one stored answer; null when it is malformed or carries nothing. */
export function normalizeAnswer(raw: unknown): ManualAnswer | null {
  if (!isRecord(raw)) return null;
  if (raw.status !== null && !isVerdict(raw.status)) return null;
  const comment = typeof raw.comment === 'string' ? raw.comment.slice(0, MAX_ANSWER_COMMENT) : '';
  const answer: ManualAnswer = {
    status: raw.status,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
  if (comment.trim().length > 0) answer.comment = comment;
  return isMeaningfulAnswer(answer) ? answer : null;
}

export function loadManualAnswers(): ManualAnswersByModel {
  const storage = optionalLocalStorage();
  if (!storage) return {};
  try {
    unwritableKeys.delete(ANSWERS_KEY);
    const raw = storage.getItem(ANSWERS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    const models = isRecord(parsed) && isRecord(parsed.models) ? parsed.models : null;
    if (!models) throw new Error('expected { schemaVersion, models }');
    const out: Record<string, Record<string, ManualAnswer>> = {};
    for (const [fingerprint, entries] of Object.entries(models)) {
      if (!fingerprint || !isRecord(entries)) continue;
      const map: Record<string, ManualAnswer> = {};
      for (const [itemId, value] of Object.entries(entries)) {
        const answer = normalizeAnswer(value);
        if (itemId && answer) map[itemId] = answer;
      }
      if (Object.keys(map).length > 0) out[fingerprint] = map;
    }
    return out;
  } catch (err) {
    // A half-built map is as destructive as an empty one on the next save. (#2085)
    onReadFailure(ANSWERS_KEY, err);
    return {};
  }
}

export function saveManualAnswers(answers: ManualAnswersByModel): ManualSaveResult {
  if (unwritableKeys.has(ANSWERS_KEY)) return { ok: false, reason: 'unreadable' };
  const storage = optionalLocalStorage();
  if (!storage) return { ok: true };
  const models: Record<string, Record<string, ManualAnswer>> = {};
  let count = 0;
  for (const [fingerprint, entries] of Object.entries(answers)) {
    const map: Record<string, ManualAnswer> = {};
    for (const [itemId, answer] of Object.entries(entries)) {
      if (!isMeaningfulAnswer(answer)) continue;
      count += 1;
      if (count > MAX_ANSWERS) return { ok: false, reason: 'too_many' };
      map[itemId] = answer;
    }
    if (Object.keys(map).length > 0) models[fingerprint] = map;
  }
  let payload: string;
  try {
    payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, models });
  } catch (err) {
    console.warn('[ifc-lite] manual validation answers could not be serialized.', err);
    return { ok: false, reason: 'serialize' };
  }
  try {
    storage.setItem(ANSWERS_KEY, payload);
    return { ok: true };
  } catch (err) {
    console.warn('[ifc-lite] manual validation answers were not saved (storage full).', err);
    return { ok: false, reason: 'quota' };
  }
}

/** The working checklist, or null when none was kept (or it is unreadable). */
export function loadWorkingChecklist(): ChecklistTemplate | null {
  const storage = optionalLocalStorage();
  if (!storage) return null;
  try {
    unwritableKeys.delete(CHECKLIST_KEY);
    const raw = storage.getItem(CHECKLIST_KEY);
    if (raw === null) return null;
    const result = parseChecklistFile(JSON.parse(raw));
    if (!result.ok) throw new Error(result.error);
    return result.template;
  } catch (err) {
    onReadFailure(CHECKLIST_KEY, err);
    return null;
  }
}

/** Keep (or, with `null`, forget) the working checklist. */
export function saveWorkingChecklist(template: ChecklistTemplate | null): ManualSaveResult {
  if (unwritableKeys.has(CHECKLIST_KEY)) return { ok: false, reason: 'unreadable' };
  const storage = optionalLocalStorage();
  if (!storage) return { ok: true };
  try {
    if (template === null) storage.removeItem(CHECKLIST_KEY);
    else storage.setItem(CHECKLIST_KEY, serializeChecklist(template));
    return { ok: true };
  } catch (err) {
    console.warn('[ifc-lite] the manual validation checklist was not saved (storage full).', err);
    return { ok: false, reason: 'quota' };
  }
}
