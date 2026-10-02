/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One canonical persistence record for live manual checklist instances
 * (#6507). Old template/answer keys are migrated once, and removed only
 * after the replacement record is saved. Failed reads preserve evidence
 * before allowing writes, using the shared storage protection (#2085). */
import {
  MANUAL_VERDICTS, MAX_ANSWER_COMMENT, parseChecklistFile,
  type ManualAnswer, type ManualAnswerMap, type ManualVerdict,
} from './checklist.js';
import { emptyManualLibrary, type ManualChecklistLibrary } from './library.js';
import { optionalLocalStorage, preserveUnreadableEntry } from '../../storage/unreadable-entry.js';

const LIBRARY_KEY = 'ifc-lite:validation:manual-library';
const LEGACY_ANSWERS_KEY = 'ifc-lite:validation:manual-answers';
const LEGACY_CHECKLIST_KEY = 'ifc-lite:validation:manual-checklist';
export const MAX_ANSWERS = 20_000;
let unwritable = false;

export type ManualSaveResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'serialize' | 'too_many' | 'unreadable' | 'no_checklist' };
export type ManualAnswersByModel = Readonly<Record<string, ManualAnswerMap>>;
export interface ManualLibraryRead {
  library: ManualChecklistLibrary;
  error: ManualSaveResult | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A comment-only answer remains unanswered in the canonical summary,
 * but is meaningful evidence and must still be retained. */
export function isMeaningfulAnswer(answer: ManualAnswer): boolean {
  return answer.status !== null || (answer.comment ?? '').trim().length > 0;
}

function normalizeAnswers(raw: unknown): ManualAnswersByModel {
  if (!isRecord(raw)) throw new Error('expected model fingerprint to answer maps');
  const out: Record<string, Record<string, ManualAnswer>> = {};
  for (const [fingerprint, entries] of Object.entries(raw)) {
    if (!fingerprint || !isRecord(entries)) continue;
    const answers: Record<string, ManualAnswer> = {};
    for (const [itemId, value] of Object.entries(entries)) {
      if (!itemId || !isRecord(value)) continue;
      if (value.status !== null && !(typeof value.status === 'string' && (MANUAL_VERDICTS as readonly string[]).includes(value.status))) continue;
      const answer: ManualAnswer = {
        status: value.status as ManualVerdict | null,
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      };
      if (typeof value.comment === 'string' && value.comment.trim()) answer.comment = value.comment.slice(0, MAX_ANSWER_COMMENT);
      if (isMeaningfulAnswer(answer)) Object.defineProperty(answers, itemId, { value: answer, enumerable: true, configurable: true, writable: true });
    }
    if (Object.keys(answers).length) Object.defineProperty(out, fingerprint, { value: answers, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

function parseLibrary(raw: unknown): ManualChecklistLibrary {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.checklists) || !(raw.activeId === null || typeof raw.activeId === 'string')) throw new Error('expected version 1 checklist library');
  const seen = new Set<string>();
  const checklists = raw.checklists.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) throw new Error('expected distinct checklist identities');
    seen.add(entry.id);
    const parsed = parseChecklistFile(entry.template);
    if (!parsed.ok) throw new Error(parsed.error);
    if (entry.preferredModelFingerprint !== undefined && !(typeof entry.preferredModelFingerprint === 'string' && entry.preferredModelFingerprint.trim())) throw new Error('expected a nonblank preferred model fingerprint');
    return { id: entry.id, template: parsed.template, answers: normalizeAnswers(entry.answers),
      ...(typeof entry.preferredModelFingerprint === 'string' ? { preferredModelFingerprint: entry.preferredModelFingerprint } : {}),
    };
  });
  if (raw.activeId !== null && !seen.has(raw.activeId)) throw new Error('active checklist identity is not in the library');
  return {
    version: 1, activeId: raw.activeId, checklists,
    ...(raw.pendingLegacyAnswers !== undefined ? { pendingLegacyAnswers: normalizeAnswers(raw.pendingLegacyAnswers) } : {}),
  };
}

function preserveReadFailure(key: string, cause: unknown): void {
  if (!preserveUnreadableEntry(optionalLocalStorage(), key, cause)) unwritable = true;
}

function readLegacy(): ManualChecklistLibrary {
  const storage = optionalLocalStorage();
  const library = emptyManualLibrary();
  if (!storage) return library;
  let answers: ManualAnswersByModel = {};
  try {
    const text = storage.getItem(LEGACY_ANSWERS_KEY);
    if (text !== null) {
      const raw: unknown = JSON.parse(text);
      if (!isRecord(raw) || raw.schemaVersion !== 1) throw new Error('expected version 1 legacy answers');
      answers = normalizeAnswers(raw.models);
    }
  } catch (error) { preserveReadFailure(LEGACY_ANSWERS_KEY, error); }
  try {
    const text = storage.getItem(LEGACY_CHECKLIST_KEY);
    if (text !== null) {
      const result = parseChecklistFile(JSON.parse(text));
      if (!result.ok) throw new Error(result.error);
      const id = 'manual-checklist-migrated';
      return { version: 1, activeId: id, checklists: [{ id, template: result.template, answers }] };
    }
  } catch (error) { preserveReadFailure(LEGACY_CHECKLIST_KEY, error); }
  if (Object.keys(answers).length) library.pendingLegacyAnswers = answers;
  return library;
}

export function loadManualLibrary(): ManualLibraryRead {
  const storage = optionalLocalStorage();
  unwritable = false;
  if (!storage) return { library: emptyManualLibrary(), error: null };
  try {
    const text = storage.getItem(LIBRARY_KEY);
    if (text !== null) return { library: parseLibrary(JSON.parse(text)), error: null };
  } catch (error) {
    preserveReadFailure(LIBRARY_KEY, error);
    return { library: emptyManualLibrary(), error: unwritable ? { ok: false, reason: 'unreadable' } : null };
  }
  const library = readLegacy();
  const saved = saveManualLibrary(library);
  if (saved.ok) {
    try {
      storage.removeItem(LEGACY_ANSWERS_KEY);
      storage.removeItem(LEGACY_CHECKLIST_KEY);
    } catch (error) {
      // The canonical record already exists; the next load uses it even if
      // the browser refuses to remove the now-superseded migration inputs.
      console.warn('[ifc-lite] superseded manual validation keys could not be removed.', error);
    }
  }
  return { library, error: saved.ok ? null : saved };
}

export function saveManualLibrary(library: ManualChecklistLibrary): ManualSaveResult {
  if (unwritable) return { ok: false, reason: 'unreadable' };
  const storage = optionalLocalStorage();
  if (!storage) return { ok: true };
  let payload: string;
  try {
    const sources = [...library.checklists.map((entry) => entry.answers), library.pendingLegacyAnswers ?? {}];
    const count = sources.reduce((total, models) => total + Object.values(models).reduce((n, entries) => n + Object.values(entries).filter(isMeaningfulAnswer).length, 0), 0);
    if (count > MAX_ANSWERS) return { ok: false, reason: 'too_many' };
    payload = JSON.stringify({
      ...library,
      checklists: library.checklists.map((entry) => ({ ...entry, answers: normalizeAnswers(entry.answers) })),
      ...(library.pendingLegacyAnswers ? { pendingLegacyAnswers: normalizeAnswers(library.pendingLegacyAnswers) } : {}),
    });
  } catch (error) {
    console.warn('[ifc-lite] manual checklist library could not be serialized.', error);
    return { ok: false, reason: 'serialize' };
  }
  try {
    storage.setItem(LIBRARY_KEY, payload);
    return { ok: true };
  } catch (error) {
    console.warn('[ifc-lite] manual checklist library was not saved (storage full).', error);
    return { ok: false, reason: 'quota' };
  }
}
