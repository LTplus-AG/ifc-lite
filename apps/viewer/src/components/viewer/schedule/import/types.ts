/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared vocabulary for the construction-schedule importers (issue #1890).
 *
 * Both front ends — MS Project's MSPDI XML and generic Gantt CSV — parse into
 * the same {@link ImportedTaskRow} shape, and a single builder turns those
 * rows into the `ScheduleExtraction` the Gantt panel and the IFC serializer
 * already consume. Keeping one intermediate means hierarchy, dependency and
 * calendar handling are written and tested once rather than per format.
 */

import type { SequenceTypeEnum } from '@ifc-lite/parser';

/** A predecessor edge as stated by the source file, before task ids are resolved. */
export interface ImportedDependency {
  /** The predecessor's id *in the source file* (MSPDI `UID`, or a CSV task id). */
  predecessorSourceId: string;
  type: SequenceTypeEnum;
  /**
   * Lag in seconds. Negative is a lead ("finish-to-start minus 2 days"), which
   * both MS Project and IFC allow, so it is preserved rather than clamped.
   */
  lagSeconds?: number;
}

/**
 * One task as read from the source file. Deliberately format-agnostic and
 * flat: nesting is expressed by {@link outlineLevel}, not by containment, since
 * that is how both MSPDI and CSV exports represent it.
 */
export interface ImportedTaskRow {
  /** Stable id within the source file; used to resolve dependencies. */
  sourceId: string;
  name: string;
  /** 1-based outline depth. 1 is top level. */
  outlineLevel: number;
  /** Local ISO 8601 datetime (no trailing `Z`), matching `toLocalIso`. */
  start?: string;
  finish?: string;
  /** ISO 8601 duration, e.g. `P5D`. */
  durationIso?: string;
  isMilestone: boolean;
  /** 0-100. */
  percentComplete?: number;
  /** Source WBS / outline number, kept as `IfcTask.Identification`. */
  wbs?: string;
  notes?: string;
  dependencies: ImportedDependency[];
}

/** Severity-free diagnostic surfaced to the user after an import. */
export interface ScheduleImportWarning {
  /** Machine-readable so the UI can group without parsing prose. */
  code:
    | 'unknown-predecessor'
    | 'unparsable-date'
    | 'ambiguous-date-format'
    | 'mixed-date-format'
    | 'unparsable-duration'
    | 'unparsable-predecessor'
    | 'outline-level-jump'
    | 'duplicate-source-id'
    | 'invalid-source-id'
    | 'duplicate-dependency'
    | 'missing-name';
  message: string;
  /** 1-based row/line in the source file, when it can be attributed to one. */
  line?: number;
}

/** What a format front end returns. */
export interface ParsedScheduleSource {
  /** Project/schedule name from the file, when it carries one. */
  projectName?: string;
  rows: ImportedTaskRow[];
  warnings: ScheduleImportWarning[];
  /**
   * How CSV day/month ordering was resolved for this file (see
   * {@link CsvDateOrder}). Only set by the CSV front end — MSPDI dates are
   * unambiguous ISO 8601 datetimes, so there is no day/month guess to report.
   */
  dateOrder?: CsvDateOrder;
}

/**
 * How CSV day/month ordering was resolved. Exposed on {@link ParsedScheduleSource}
 * so the UI can tell the user which reading was used — a silently wrong guess
 * here shifts every date in the schedule, so it is reported rather than assumed.
 */
export type CsvDateOrder = 'iso' | 'day-first' | 'month-first';
