/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StudioDocument } from '@ifc-lite/ids-authoring';

export const IDS_DRAFT_MAX_MIB = 4;
const MAX_BYTES = IDS_DRAFT_MAX_MIB * 1024 * 1024;

export interface IdsStudioDraft {
  version: 2;
  id: string;
  title: string;
  savedAt: number;
  /** The complete authoring document, including drafts that cannot be exported as IDS XML yet. */
  document: string;
}

export type IdsDraftEncoding =
  | { ok: true; draft: IdsStudioDraft }
  | { ok: false; reason: 'tooLarge' | 'serialize' };

function withinLimit(document: string): boolean {
  return document.length <= MAX_BYTES && new TextEncoder().encode(document).byteLength <= MAX_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the versioned backup envelope without pulling the Studio runtime into the viewer entry chunk. */
export function decodeIdsStudioDraft(value: unknown): IdsStudioDraft | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.id.length > 128
    || typeof value.title !== 'string' || value.title.length > 200
    || typeof value.savedAt !== 'number' || !Number.isSafeInteger(value.savedAt)
    || value.savedAt < 0 || value.savedAt > 8.64e15) return null;
  let document: string;
  if (value.version === 1 && isRecord(value.document)) {
    // V1 stores the document inline. V2 isolates it so a backup can keep the
    // original snapshot intact even if the authoring runtime cannot open it.
    try { document = JSON.stringify(value.document); }
    catch (error) { console.warn('[IDS Studio] Unreadable v1 draft', error); return null; }
  } else if (value.version === 2 && typeof value.document === 'string') {
    document = value.document;
  } else return null;
  return withinLimit(document) ? { version: 2, id: value.id, title: value.title, savedAt: value.savedAt, document } : null;
}

export function encodeIdsStudioDraft(id: string, doc: StudioDocument, savedAt = Date.now()): IdsDraftEncoding {
  try {
    const document = JSON.stringify(doc);
    if (!withinLimit(document)) return { ok: false, reason: 'tooLarge' };
    return { ok: true, draft: { version: 2, id, title: doc.ids.info.title.slice(0, 200), savedAt, document } };
  } catch (error) {
    console.warn('[IDS Studio] Could not serialize draft', error);
    return { ok: false, reason: 'serialize' };
  }
}
