/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parts of buildagil's openCDE responses this provider reads, narrowed by
 * hand. A row with a wrong-typed required field is dropped, never coerced.
 */

export interface BuildagilProject { readonly id: string; readonly name: string; readonly number?: string; readonly location?: string; readonly link?: string }

export interface BuildagilDocument {
  readonly guid: string;
  readonly filename: string;
  /** Normalized: starts with `/documents`, no trailing slash. */
  readonly folder: string;
  readonly versionIndex: number;
  readonly versionNumber?: string;
  readonly modifiedAt?: string;
  readonly modifiedBy?: string;
  readonly sizeBytes?: number;
  readonly status?: string;
  readonly link?: string;
}

export interface BuildagilVersion {
  readonly index: number; readonly number?: string; readonly modifiedAt?: string; readonly modifiedBy?: string; readonly sizeBytes?: number;
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number | undefined =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** The documents root every `folder_url` sits under. */
export const DOCUMENTS_ROOT = '/documents';

export function normalizeFolder(raw: string | undefined): string {
  const trimmed = (raw ?? '').replace(/\/+$/, '');
  if (trimmed === DOCUMENTS_ROOT || trimmed.startsWith(`${DOCUMENTS_ROOT}/`)) return trimmed;
  return DOCUMENTS_ROOT;
}

export function rows<T>(value: unknown, decode: (row: Row) => T | undefined): T[] {
  if (!Array.isArray(value)) throw new Error('buildagil returned an unexpected response (expected a list).');
  return value.flatMap((item) => {
    const r = row(item);
    const decoded = r && decode(r);
    return decoded ? [decoded] : [];
  });
}

export function decodeProject(r: Row): BuildagilProject | undefined {
  const id = text(r.project_id);
  const name = text(r.name);
  return id && name ? { id, name, number: text(r.number), location: text(r.location), link: text(r.link) } : undefined;
}

export function decodeDocument(r: Row): BuildagilDocument | undefined {
  const guid = text(r.guid);
  const filename = text(r.filename);
  const versionIndex = count(r.version_index);
  if (!guid || !filename || versionIndex === undefined) return undefined;
  return {
    guid, filename, folder: normalizeFolder(text(r.folder_url)), versionIndex,
    versionNumber: text(r.version_number), modifiedAt: text(r.modified_date), modifiedBy: text(r.modified_author),
    sizeBytes: count(r.size_in_bytes), status: text(r.status), link: text(r.link),
  };
}

export function decodeVersion(r: Row): BuildagilVersion | undefined {
  const index = count(r.version_index);
  return index === undefined ? undefined : {
    index, number: text(r.version_number), modifiedAt: text(r.modified_date),
    modifiedBy: text(r.modified_author), sizeBytes: count(r.size_in_bytes),
  };
}

/** `POST /1.0/search`: the document hits and the total match count. */
export function decodeSearch(value: unknown): { documents: BuildagilDocument[]; total: number } {
  const body = row(value);
  if (!body || !Array.isArray(body.search_result)) throw new Error('buildagil returned an unexpected search response.');
  const documents = rows(body.search_result, (r) => (r.type === 'Document' ? decodeDocument(r) : undefined));
  return { documents, total: count(body.total_count) ?? documents.length };
}

/** Creation time for scan ordering, or undefined when unparseable. */
export function creationTime(r: Row): string | undefined {
  const raw = text(r.creation_date);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}
