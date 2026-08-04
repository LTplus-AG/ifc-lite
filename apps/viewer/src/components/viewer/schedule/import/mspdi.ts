/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MS Project MSPDI (`.xml`) → {@link ImportedTaskRow}s (issue #1890).
 *
 * MSPDI is the XML interchange format Microsoft Project reads and writes
 * natively ("Save As → XML"). It is the *lossless* path for this importer:
 * dates are unambiguous ISO datetimes, durations are already ISO 8601, and
 * dependency links carry an explicit type and lag. The `.mpp` binary format is
 * closed and is deliberately not attempted — users export XML instead.
 *
 * Element semantics below are per Microsoft's MSPDI reference:
 *   - `PredecessorLink/Type` — 0 FF, 1 FS, 2 SF, 3 SS
 *   - `PredecessorLink/LinkLag` — tenths of a minute
 * Both are verified against the published schema docs rather than inferred
 * from sample files, because getting either backwards silently inverts or
 * mis-scales every dependency in the schedule.
 *
 * Parsing uses the platform `DOMParser`. The viewer runs this on the main
 * thread where it is native, and the happy-dom test harness provides it — so
 * this adds neither a dependency nor a third hand-rolled XML scanner to the
 * repo (`packages/pointcloud`'s `xml-mini` exists only because *workers* lack
 * DOMParser, and it is package-internal).
 */

import type { SequenceTypeEnum } from '@ifc-lite/parser';
import type { ImportedDependency, ImportedTaskRow, ParsedScheduleSource, ScheduleImportWarning } from './types.js';

/** MSPDI `PredecessorLink/Type` → IFC sequence type. */
const LINK_TYPE_BY_CODE: Record<string, SequenceTypeEnum> = {
  '0': 'FINISH_FINISH',
  '1': 'FINISH_START',
  '2': 'START_FINISH',
  '3': 'START_START',
};

/** `LinkLag` is expressed in tenths of a minute: 600 tenths = 60 min = 3600 s. */
const SECONDS_PER_LINK_LAG_UNIT = 6;

/**
 * Direct children of `parent` whose local name matches, ignoring namespace
 * prefixes. MSPDI declares a default namespace, and matching on `localName`
 * keeps this working whether or not a producer prefixes its elements.
 */
function childrenByLocalName(parent: Element, name: string): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (child.localName === name) out.push(child);
  }
  return out;
}

function childText(parent: Element, name: string): string | undefined {
  const el = childrenByLocalName(parent, name)[0];
  const text = el?.textContent?.trim();
  return text ? text : undefined;
}

function childNumber(parent: Element, name: string): number | undefined {
  const raw = childText(parent, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** MSPDI booleans are `0`/`1`; treat anything else as false rather than throwing. */
function childBoolean(parent: Element, name: string): boolean {
  return childText(parent, name) === '1';
}

/**
 * Normalize an MSPDI datetime to the local-ISO form the rest of the schedule
 * code uses (`toLocalIso`: no trailing `Z`, second precision).
 *
 * MSPDI writes `2026-01-05T08:00:00` — already local wall-clock with no zone —
 * so the correct handling is to pass it through, *not* to round-trip it via
 * `new Date()`, which would reinterpret it in the runner's timezone and shift
 * every task by the UTC offset.
 */
function normalizeDateTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}`;
}

/**
 * MSPDI durations are already ISO 8601 (`PT40H0M0S`). Zero-valued components
 * are dropped so the result reads like the rest of the codebase's durations
 * (`P5D`, `PT8H`) instead of `PT40H0M0S`, without changing the value.
 */
function normalizeDuration(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    raw.trim(),
  );
  if (!match) return undefined;
  const [, d, h, mi, s] = match;
  const days = Number(d ?? 0);
  const hours = Number(h ?? 0);
  const minutes = Number(mi ?? 0);
  const seconds = Number(s ?? 0);
  if (days === 0 && hours === 0 && minutes === 0 && seconds === 0) return 'PT0S';
  const datePart = days > 0 ? `${days}D` : '';
  const timePart =
    (hours > 0 ? `${hours}H` : '') + (minutes > 0 ? `${minutes}M` : '') + (seconds > 0 ? `${seconds}S` : '');
  return `P${datePart}${timePart ? `T${timePart}` : ''}`;
}

// `LagFormat` 19 (percent) / 20 (elapsed percent) means `LinkLag` is
// tenths-of-a-percent of the PREDECESSOR'S duration, not a time unit at all
// — 200 with LagFormat 19 means 20%, not "200 * SECONDS_PER_LINK_LAG_UNIT
// seconds". 51 / 52 are the same percent / elapsed-percent formats with
// Project's "estimated" (`?`) flag set on the duration — same tenths-of-a-
// percent unit, just also marked estimated. Converting any of these to an
// actual time lag needs the predecessor's resolved duration, which isn't
// available at this point in parsing, so the honest fix is to drop the lag
// (keep the dependency edge itself) and warn, rather than import a value
// that is wrong by an arbitrary and unknowable factor.
const PERCENT_LAG_FORMATS = new Set(['19', '20', '51', '52']);

function readDependencies(taskEl: Element, warnings: ScheduleImportWarning[], taskName: string): ImportedDependency[] {
  const deps: ImportedDependency[] = [];
  for (const link of childrenByLocalName(taskEl, 'PredecessorLink')) {
    // A `PredecessorUID` is taken exactly as written, integer or not: it is
    // the file's own statement of which task the link points at, so keeping
    // it lets the link resolve against a task carrying the same
    // non-conformant UID. If no task does, `buildScheduleExtraction` already
    // reports it as `unknown-predecessor` — the same signal any other
    // unresolved predecessor gets. Rejecting it here would instead delete a
    // real dependency edge from a file whose ids merely aren't integers.
    const predecessorSourceId = childText(link, 'PredecessorUID');
    if (!predecessorSourceId) {
      // Report rather than guess-and-drop: a PredecessorLink with no UID at
      // all is data loss the same as any other dropped dependency edge, and
      // silently continuing here previously left the user with no signal
      // that a link in the source file never made it into the import.
      warnings.push({
        code: 'unparsable-predecessor',
        message: `Task "${taskName}" has a PredecessorLink with no PredecessorUID, link dropped.`,
      });
      continue;
    }
    const typeCode = childText(link, 'Type') ?? '1';
    const type = LINK_TYPE_BY_CODE[typeCode];
    if (!type) {
      warnings.push({
        code: 'unparsable-predecessor',
        message: `Task "${taskName}": unknown PredecessorLink Type "${typeCode}", treated as Finish-Start.`,
      });
    }
    const linkLag = childNumber(link, 'LinkLag');
    const lagFormat = childText(link, 'LagFormat');
    let lagSeconds: number | undefined;
    if (lagFormat !== undefined && PERCENT_LAG_FORMATS.has(lagFormat)) {
      if (linkLag !== undefined && linkLag !== 0) {
        warnings.push({
          code: 'unparsable-predecessor',
          message:
            `Task "${taskName}": predecessor "${predecessorSourceId}" uses lag format ${lagFormat} ` +
            '(percent of predecessor duration), which this importer does not convert. Link kept, lag dropped.',
        });
      }
      lagSeconds = undefined;
    } else {
      lagSeconds = linkLag === undefined || linkLag === 0 ? undefined : linkLag * SECONDS_PER_LINK_LAG_UNIT;
    }
    deps.push({
      predecessorSourceId,
      type: type ?? 'FINISH_START',
      lagSeconds,
    });
  }
  return deps;
}

/**
 * Parse an MSPDI document. Throws only when the payload is not XML at all or
 * carries no `<Task>` elements; per-task problems are reported as warnings so
 * one malformed row cannot cost the user the whole import.
 */
export function parseMspdi(xml: string): ParsedScheduleSource {
  const warnings: ScheduleImportWarning[] = [];
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  // DOMParser signals XML errors in-band with a <parsererror> element rather
  // than by throwing, so an unchecked parse would yield a silently empty import.
  const parseError = doc.getElementsByTagName('parsererror')[0];
  if (parseError) {
    throw new Error(`Not valid XML: ${parseError.textContent?.trim().split('\n')[0] ?? 'unknown parse error'}`);
  }

  const root = doc.documentElement;
  if (!root) throw new Error('Not valid XML: no root element.');

  const tasksParent = childrenByLocalName(root, 'Tasks')[0];
  const taskElements = tasksParent ? childrenByLocalName(tasksParent, 'Task') : [];
  if (taskElements.length === 0) {
    throw new Error('No <Task> elements found. Is this a Microsoft Project XML (MSPDI) file?');
  }

  const rows: ImportedTaskRow[] = [];
  const seenIds = new Set<string>();
  /** Every id the file itself states, resolved before any id is synthesized. */
  const statedUids = new Set<string>();
  for (const taskEl of taskElements) {
    const stated = childText(taskEl, 'UID');
    if (stated !== undefined) statedUids.add(stated);
  }
  /**
   * Positional id → the id actually used, for every synthesized id a stated
   * UID was already occupying. Empty for every file that does not do this,
   * which is the only reason the warning below is ever silent.
   */
  const displacedIds = new Map<string, string>();

  /**
   * An id for a task the file gave no `UID`. `row-<n>` comes from the task's
   * position, so two synthesized ids can never equal each other — but nothing
   * stops a *stated* UID being the literal string `row-2`. A conformant file
   * cannot do that (the schema types `UID` as `xsd:integer`, and no integer
   * spells `row-2`), a hand-edited one can, and then the two tasks share an
   * id: the second is dropped as a duplicate and the user is told about a
   * "duplicate UID" they never wrote. Suffix until the id is one nothing in
   * the file states, so both tasks survive and the stated id keeps pointing
   * at the task that stated it.
   */
  const synthesizeSourceId = (index: number): string => {
    const positional = `row-${index + 1}`;
    let id = positional;
    while (statedUids.has(id)) id += '-x';
    if (id !== positional) displacedIds.set(positional, id);
    return id;
  };

  taskElements.forEach((taskEl, index) => {
    const uid = childText(taskEl, 'UID');
    // MS Project emits a synthetic UID 0 project-summary row. It is not a real
    // task and importing it would wrap the whole schedule in a phantom parent.
    if (uid === '0') return;

    const sourceId = uid ?? synthesizeSourceId(index);
    if (seenIds.has(sourceId)) {
      warnings.push({
        code: 'duplicate-source-id',
        message: `Duplicate task UID "${sourceId}", the later occurrence was skipped.`,
      });
      return;
    }
    seenIds.add(sourceId);

    let name = childText(taskEl, 'Name');
    if (!name) {
      name = `Task ${sourceId}`;
      warnings.push({ code: 'missing-name', message: `Task UID ${sourceId} has no Name, using "${name}".` });
    }

    const outlineLevel = childNumber(taskEl, 'OutlineLevel');
    const percent = childNumber(taskEl, 'PercentComplete');

    // Unlike the CSV path (which already warns on every unparsable date/
    // duration cell), unparsable Start/Finish/Duration here used to return
    // `undefined` with no warning at all — the value silently disappeared.
    // Warn whenever the source carried a value that didn't normalize.
    const startRaw = childText(taskEl, 'Start');
    const finishRaw = childText(taskEl, 'Finish');
    const durationRaw = childText(taskEl, 'Duration');
    const start = normalizeDateTime(startRaw);
    const finish = normalizeDateTime(finishRaw);
    const durationIso = normalizeDuration(durationRaw);
    if (startRaw && !start) {
      warnings.push({ code: 'unparsable-date', message: `Task "${name}": could not read Start "${startRaw}".` });
    }
    if (finishRaw && !finish) {
      warnings.push({ code: 'unparsable-date', message: `Task "${name}": could not read Finish "${finishRaw}".` });
    }
    if (durationRaw && !durationIso) {
      warnings.push({
        code: 'unparsable-duration',
        message: `Task "${name}": could not read Duration "${durationRaw}".`,
      });
    }

    rows.push({
      sourceId,
      name,
      outlineLevel: outlineLevel !== undefined && outlineLevel > 0 ? Math.floor(outlineLevel) : 1,
      start,
      finish,
      durationIso,
      isMilestone: childBoolean(taskEl, 'Milestone'),
      percentComplete: percent === undefined ? undefined : Math.max(0, Math.min(100, percent)),
      wbs: childText(taskEl, 'WBS') ?? childText(taskEl, 'OutlineNumber'),
      notes: childText(taskEl, 'Notes'),
      dependencies: readDependencies(taskEl, warnings, name),
    });
  });

  // Reported only when a stated UID actually displaced a synthesized one —
  // never merely because an id is not an `xsd:integer`. A file that numbers
  // its tasks `A1, A2, …` imports exactly as it always has (same rows, same
  // ids, same links), so a diagnostic on it would be a false alarm that also
  // costs the user their success toast: `describeImportOutcome` treats any
  // warning as a failed-ish import. Here something did happen — a task's id
  // is not the one its position implies — and the message has to say so,
  // because that id is what the user sees in the imported schedule.
  //
  // One warning for the file rather than one per displaced task: it is a
  // property of the document's id scheme, and repeating it would bury the
  // per-task warnings (missing name, unreadable dates) the user must act on
  // row by row.
  if (displacedIds.size > 0) {
    const pairs = Array.from(displacedIds, ([positional, used]) => `"${positional}" → "${used}"`);
    const sample = pairs.slice(0, 3).join(', ');
    warnings.push({
      code: 'synthesized-id-collision',
      message:
        `${pairs.length} task(s) with no <UID> could not take the id their position implies, because the ` +
        `file states that id for another task (${sample}${pairs.length > 3 ? ', …' : ''}). Every task was ` +
        'imported and the stated ids were left alone. MS Project writes integer UIDs, which can never ' +
        'collide this way — check this file was not hand-edited.',
    });
  }

  if (rows.length === 0) {
    throw new Error('The file contained only the project summary row, no tasks to import.');
  }

  return { projectName: childText(root, 'Name') ?? childText(root, 'Title'), rows, warnings };
}
