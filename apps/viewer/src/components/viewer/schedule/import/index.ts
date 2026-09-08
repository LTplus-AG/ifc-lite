/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Format dispatcher for the construction-schedule importer (issue #1890).
 *
 * Picks between the two front ends (`mspdi.ts`, `csv.ts`) and hands their
 * common {@link ParsedScheduleSource} to `buildScheduleExtraction`, giving the
 * UI a single entry point regardless of which file the user dropped in.
 */

import type { ScheduleExtraction } from '@ifc-lite/parser';
import { buildScheduleExtraction } from './build.js';
import { parseScheduleCsv } from './csv.js';
import { parseMspdi } from './mspdi.js';
import type { CsvDateOrder, ScheduleImportWarning } from './types.js';

export interface ScheduleImportResult {
  extraction: ScheduleExtraction;
  warnings: ScheduleImportWarning[];
  format: 'mspdi' | 'csv';
  taskCount: number;
  sequenceCount: number;
  /** How CSV day/month ordering was resolved; undefined for an MSPDI import. */
  dateOrder?: CsvDateOrder;
}

/**
 * Decide MSPDI vs CSV by sniffing content first, extension second.
 *
 * Content wins because file extensions lie in practice (an MSPDI export
 * saved with a `.txt` extension, a CSV renamed to `.xml` by a careless
 * re-save) far more often than the first non-whitespace byte of the file
 * does. A BOM or leading whitespace is skipped before looking at the first
 * character, since Excel and MS Project both happily prepend one.
 *
 * Only the *first* character is sniffed — not a substring search anywhere
 * in the file. A prior version also matched a bare `<Project` occurring
 * anywhere in the text, which misrouted a perfectly valid CSV whose Notes
 * column happened to mention "<Project>" to the XML parser. Every real
 * MSPDI document starts with `<` once BOM/whitespace is stripped (an `<?xml`
 * declaration, a leading comment, or the bare `<Project` root), so
 * `startsWith('<')` alone is both necessary and sufficient.
 */
function detectFormat(fileName: string, text: string): 'mspdi' | 'csv' {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = withoutBom.trimStart();
  if (trimmed.startsWith('<')) return 'mspdi';

  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.xml')) return 'mspdi';
  if (lowerName.endsWith('.csv') || lowerName.endsWith('.txt')) return 'csv';

  // No content signal and no recognised extension: fall back to the
  // extension-independent default. CSV is the more permissive parser to
  // fail on (it complains clearly about a missing name column, whereas
  // MSPDI needs well-formed XML), so it is the safer guess.
  return 'csv';
}

/**
 * Parse `text` (the contents of a file the user picked) into a
 * `ScheduleExtraction` ready for `commitGeneratedSchedule`.
 *
 * The GlobalId seed is derived from the file name plus the parsed project
 * name (when the source carries one) rather than from file content or a
 * random value: re-importing the exact same file — the common "I fixed one
 * date and re-exported" workflow — must produce the same task GlobalIds so
 * the re-import replaces rather than duplicates the schedule, while two
 * different files that happen to share a project name (e.g. two phases both
 * titled "Project1") still get distinct seeds because the file name differs.
 *
 * Parser errors (malformed XML, missing columns, empty file) are rethrown
 * unchanged — the UI surfaces `Error#message` directly.
 */
export function importScheduleFromText(
  fileName: string,
  text: string,
  scheduleName?: string,
): ScheduleImportResult {
  // `.mpp` is MS Project's closed, binary format (see docs/guide/
  // schedule-import.md's "Supported inputs" section) and is never parsed —
  // there is no content signal to sniff (it isn't XML or CSV), so without
  // this check it would silently fall through to the CSV parser's generic
  // "no data rows" / "no name column" error, which names the wrong problem
  // entirely. Checking the extension up front gives the user the actual
  // reason and the fix (Save As → XML) instead.
  if (fileName.toLowerCase().endsWith('.mpp')) {
    throw new Error(
      `"${fileName}" is a Microsoft Project .mpp file, which this importer does not read (it's a closed, binary ` +
      'format). In MS Project, use File → Save As → XML and import that file instead.',
    );
  }
  const format = detectFormat(fileName, text);
  const source = format === 'mspdi' ? parseMspdi(text) : parseScheduleCsv(text);

  const seed = `schedule-import|${fileName}|${source.projectName ?? ''}`;
  const { extraction, warnings } = buildScheduleExtraction(source, { seed, scheduleName });

  return {
    extraction,
    warnings,
    format,
    taskCount: extraction.tasks.length,
    sequenceCount: extraction.sequences.length,
    dateOrder: source.dateOrder,
  };
}
