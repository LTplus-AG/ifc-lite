/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DEFAULT_CLASH_SETTINGS, EXCLUSIONS_KEY, PRESETS_KEY, REVIEWS_KEY, SCHEMA_VERSION, SETTINGS_KEY,
  decodeStoredExclusions, decodeStoredPresets, decodeStoredReviews, decodeStoredSettings,
} from '../clash/persistence-codecs.js';
import { BASELINE_KEY, decodeRevisionBaseline, encodeRevisionBaseline } from '../clash/revision-baseline.js';
import { DEFINITION_LIBRARY_KEY, decodeDefinitionLibrary, encodeDefinitionLibrary } from '../validation/definition-library.js';
import {
  LEGACY_ANSWERS_KEY, LEGACY_CHECKLIST_KEY, MANUAL_LIBRARY_KEY,
  decodeManualLibrary, encodeManualLibrary,
} from '../validation/manual/persistence.js';
import { sameReportEvidence } from '../flow/report-provenance.js';

interface WorkCodec {
  /** Null represents an empty/default record. */
  canonical(raw: string): string | null;
  merge?(local: string, incoming: string): WorkMerge;
}

interface WorkMerge {
  raw: string;
  conflict: boolean;
}

/** Some identities (e.g. a review's durable clash key) cannot be reminted:
 * keep the current row and preserve the incoming snapshot as recovery evidence. */
function mergeRows<T>(local: T[], incoming: T[], identity: (row: T) => string) {
  const rows = new Map(local.map(row => [identity(row), row]));
  let conflict = false;
  for (const row of incoming) {
    const id = identity(row);
    const previous = rows.get(id);
    if (previous === undefined) rows.set(id, row);
    else if (!sameReportEvidence(previous, row)) conflict = true;
  }
  return { rows: [...rows.values()], conflict };
}

function clashRows<T>(field: string, decode: (value: unknown) => T[], identity: (row: T) => string, encode: (rows: T[]) => unknown = rows => rows): WorkCodec {
  const wrap = (rows: T[]) => JSON.stringify({ schemaVersion: SCHEMA_VERSION, [field]: encode(rows) });
  return {
    canonical: raw => {
      const rows = decode(JSON.parse(raw));
      return rows.length ? wrap(rows) : null;
    },
    merge: (local, incoming) => {
      const { rows, conflict } = mergeRows(decode(JSON.parse(local)), decode(JSON.parse(incoming)), identity);
      const raw = wrap(rows);
      // Recheck the native count limit before any write.
      decode(JSON.parse(raw));
      return { raw, conflict };
    },
  };
}

export function encodeClashWorkSettings(raw: string): string | null {
  const { groupBy: _displayOnly, ...settings } = decodeStoredSettings(JSON.parse(raw));
  const { groupBy: _defaultDisplay, ...defaults } = DEFAULT_CLASH_SETTINGS;
  return sameReportEvidence(settings, defaults) ? null : JSON.stringify({ schemaVersion: SCHEMA_VERSION, settings });
}

/** Explicit opt-in by native key. Never enumerate storage values for backup. */
export const LOCAL_WORK_CODECS = {
  [PRESETS_KEY]: clashRows('presets', value => decodeStoredPresets(value, true), row => row.id),
  [REVIEWS_KEY]: clashRows('reviews', value => [...decodeStoredReviews(value, true)], ([id]) => id, Object.fromEntries),
  [EXCLUSIONS_KEY]: clashRows('exclusions', value => decodeStoredExclusions(value, true), row => row.id),
  [SETTINGS_KEY]: { canonical: encodeClashWorkSettings },
  [BASELINE_KEY]: { canonical: raw => encodeRevisionBaseline(decodeRevisionBaseline(raw)) },
  [DEFINITION_LIBRARY_KEY]: {
    canonical: raw => {
      const library = decodeDefinitionLibrary(raw);
      return library.entries.length ? encodeDefinitionLibrary(library) : null;
    },
    merge: (local, incoming) => {
      const current = decodeDefinitionLibrary(local), imported = decodeDefinitionLibrary(incoming);
      const { rows, conflict } = mergeRows(current.entries, imported.entries, row => row.id);
      return { raw: encodeDefinitionLibrary({ ...current, entries: rows }), conflict };
    },
  },
  [MANUAL_LIBRARY_KEY]: {
    canonical: raw => {
      const library = decodeManualLibrary(raw, true);
      if (!library.checklists.length && !Object.keys(library.pendingLegacyAnswers ?? {}).length) return null;
      const encoded = encodeManualLibrary(library);
      if (encoded === null) throw new Error('Too many manual validation answers');
      return encoded;
    },
    merge: (local, incoming) => {
      const current = decodeManualLibrary(local, true), imported = decodeManualLibrary(incoming, true);
      const { rows, conflict } = mergeRows(current.checklists, imported.checklists, row => row.id);
      const pending = mergeRows(Object.entries(current.pendingLegacyAnswers ?? {}), Object.entries(imported.pendingLegacyAnswers ?? {}), ([id]) => id);
      const raw = encodeManualLibrary({ ...current, checklists: rows,
        ...(pending.rows.length ? { pendingLegacyAnswers: Object.fromEntries(pending.rows) } : {}),
      });
      if (raw === null) throw new Error('Too many manual validation answers');
      return { raw, conflict: conflict || pending.conflict };
    },
  },
} satisfies Record<string, WorkCodec>;

export type LocalWorkKey = keyof typeof LOCAL_WORK_CODECS;
export const LOCAL_WORK_KEYS = Object.keys(LOCAL_WORK_CODECS) as LocalWorkKey[];
const backupSourceKeys = [...LOCAL_WORK_KEYS, LEGACY_ANSWERS_KEY, LEGACY_CHECKLIST_KEY];
export function isLocalWorkKey(value: string): value is LocalWorkKey {
  return Object.hasOwn(LOCAL_WORK_CODECS, value);
}
export function isLocalWorkOriginalKey(value: string): boolean {
  return backupSourceKeys.some(key => {
    const prefix = `${key}:unreadable`;
    return value === key || value === prefix
      || (value.startsWith(`${prefix}:`) && /^[0-9]+$/.test(value.slice(prefix.length + 1)));
  });
}
export function localWorkCodec(key: LocalWorkKey): WorkCodec { return LOCAL_WORK_CODECS[key]; }
