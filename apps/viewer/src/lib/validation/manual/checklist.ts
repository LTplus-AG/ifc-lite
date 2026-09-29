/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual validation (#6401): a checklist a coordinator works through by
 * eye — "the model was uploaded to the CDE on time", "objects sit on the
 * right storey" — recording Pass / Fail / Warning and a comment per check.
 *
 * The TEMPLATE and the ANSWERS are deliberately separate:
 *
 * - `ChecklistTemplate` is the reusable structure, saved and opened as a
 *   `<name>.checklist.json` file. It never carries a verdict, so one file
 *   can be handed around a team and reused on every model.
 * - `ManualAnswer`s live per model (keyed by the model's source
 *   fingerprint, see `answers-persistence.ts`), keyed by item id.
 *
 * Manual results never enter `ValidationReport` (`idsSlice`'s report slot):
 * they are a different kind of evidence and must not replace or be replaced
 * by an IDS or information-validation run.
 */

export const CHECKLIST_VERSION = 1;

export interface ChecklistItem {
  id: string;
  /** What was checked, shown on the row. */
  text: string;
  /** Optional longer guidance for the person doing the check. */
  description?: string;
}

export interface ChecklistGroup {
  id: string;
  name: string;
  items: ChecklistItem[];
}

export interface ChecklistTemplate {
  version: typeof CHECKLIST_VERSION;
  name: string;
  groups: ChecklistGroup[];
}

export type ManualVerdict = 'pass' | 'fail' | 'warning';
export const MANUAL_VERDICTS: readonly ManualVerdict[] = ['pass', 'fail', 'warning'];

/** One item's answer on one model. `status: null` is "not checked yet" —
 *  a comment can exist before a verdict does. */
export interface ManualAnswer {
  status: ManualVerdict | null;
  comment?: string;
  updatedAt: number;
}

/** itemId → answer, for one model. */
export type ManualAnswerMap = Readonly<Record<string, ManualAnswer>>;

export const MAX_CHECKLIST_GROUPS = 200;
export const MAX_CHECKLIST_ITEMS_PER_GROUP = 500;
export const MAX_CHECKLIST_TEXT = 500;
export const MAX_CHECKLIST_DESCRIPTION = 2_000;
export const MAX_ANSWER_COMMENT = 2_000;

export function newChecklistId(prefix: 'group' | 'item'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function blankChecklist(): ChecklistTemplate {
  return { version: CHECKLIST_VERSION, name: '', groups: [] };
}

export type ChecklistParseResult =
  | { ok: true; template: ChecklistTemplate }
  | { ok: false; error: string };

class ChecklistError extends Error {}

function fail(message: string): never {
  throw new ChecklistError(message);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseItem(raw: unknown, at: string, ids: Set<string>): ChecklistItem {
  if (!isRecord(raw)) fail(`${at} must be an object`);
  if (typeof raw.id !== 'string' || raw.id.length === 0) fail(`${at}.id must be a non-empty string`);
  if (ids.has(raw.id)) fail(`${at}.id "${raw.id}" is used twice`);
  ids.add(raw.id);
  if (typeof raw.text !== 'string') fail(`${at}.text must be a string`);
  if (raw.description !== undefined && typeof raw.description !== 'string') fail(`${at}.description must be a string`);
  const item: ChecklistItem = { id: raw.id, text: raw.text.slice(0, MAX_CHECKLIST_TEXT) };
  if (typeof raw.description === 'string' && raw.description.length > 0) {
    item.description = raw.description.slice(0, MAX_CHECKLIST_DESCRIPTION);
  }
  return item;
}

function parseGroup(raw: unknown, at: string, ids: Set<string>): ChecklistGroup {
  if (!isRecord(raw)) fail(`${at} must be an object`);
  if (typeof raw.id !== 'string' || raw.id.length === 0) fail(`${at}.id must be a non-empty string`);
  if (ids.has(raw.id)) fail(`${at}.id "${raw.id}" is used twice`);
  ids.add(raw.id);
  if (typeof raw.name !== 'string') fail(`${at}.name must be a string`);
  if (!Array.isArray(raw.items)) fail(`${at}.items must be an array`);
  if (raw.items.length > MAX_CHECKLIST_ITEMS_PER_GROUP) fail(`${at}.items has more than ${MAX_CHECKLIST_ITEMS_PER_GROUP} checks`);
  return {
    id: raw.id,
    name: raw.name.slice(0, MAX_CHECKLIST_TEXT),
    items: raw.items.map((item, i) => parseItem(item, `${at}.items[${i}]`, ids)),
  };
}

/**
 * Validate a parsed `.checklist.json`. Never throws: every problem comes
 * back as `{ ok: false, error }` naming the JSON path. A `version` newer than
 * this build is refused with its own message (the file is fine, this viewer
 * is older), and ids must be unique across groups AND items because answers
 * are keyed by item id alone.
 */
export function parseChecklistFile(raw: unknown): ChecklistParseResult {
  try {
    if (!isRecord(raw)) fail('expected an object');
    if (typeof raw.version === 'number' && raw.version > CHECKLIST_VERSION) {
      fail(`saved by a newer version of ifc-lite (checklist version ${raw.version}); this viewer knows up to version ${CHECKLIST_VERSION}`);
    }
    if (raw.version !== CHECKLIST_VERSION) fail(`"version" must be ${CHECKLIST_VERSION}`);
    if (typeof raw.name !== 'string') fail('"name" must be a string');
    if (!Array.isArray(raw.groups)) fail('"groups" must be an array');
    if (raw.groups.length > MAX_CHECKLIST_GROUPS) fail(`"groups" has more than ${MAX_CHECKLIST_GROUPS} groups`);
    const ids = new Set<string>();
    const groups = raw.groups.map((group, i) => parseGroup(group, `groups[${i}]`, ids));
    return { ok: true, template: { version: CHECKLIST_VERSION, name: raw.name.slice(0, MAX_CHECKLIST_TEXT), groups } };
  } catch (err) {
    if (err instanceof ChecklistError) return { ok: false, error: err.message };
    throw err;
  }
}

/** The `.checklist.json` text: the template only, never answers. */
export function serializeChecklist(template: ChecklistTemplate): string {
  const clean: ChecklistTemplate = {
    version: CHECKLIST_VERSION,
    name: template.name,
    groups: template.groups.map((g) => ({
      id: g.id,
      name: g.name,
      items: g.items.map((item) => (item.description ? { id: item.id, text: item.text, description: item.description } : { id: item.id, text: item.text })),
    })),
  };
  return `${JSON.stringify(clean, null, 2)}\n`;
}

/** Parse the TEXT of a `.checklist.json` (file picker, recent cache). */
export function parseChecklistText(text: string): ChecklistParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }
  return parseChecklistFile(parsed);
}
