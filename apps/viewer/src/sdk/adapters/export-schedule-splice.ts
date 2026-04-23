/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helper for splicing an in-memory schedule into a STEP export.
 *
 * Three export surfaces (ExportChangesButton, ExportDialog, SDK
 * adapter) previously re-implemented the same decode-inject-re-encode
 * dance. Two of the three shipped a bug at different times:
 *   • gate on `typeof result.content === 'string'` silently dropped
 *     the splice when `StepExporter.export()` returned `Uint8Array`
 *   • gate on `scheduleSourceModelId === selectedModelId` missed
 *     single-model sessions where `sourceModelId` was `null`
 *
 * Centralising into one function kills both bug classes — the three
 * surfaces become one-liners over the same contract.
 */

import type { IfcDataStore, ScheduleExtraction } from '@ifc-lite/parser';
import { injectScheduleIntoStep } from './export-adapter.js';

export interface ExportScheduleState {
  /** In-memory schedule — generated tasks, edits, or parsed+untouched. */
  scheduleData: ScheduleExtraction | null;
  /** True when the user has edited the schedule since load / generation. */
  scheduleIsEdited: boolean;
  /**
   * Model the schedule is attributed to. Null for purely-parsed schedules
   * that haven't been touched (or for single-model sessions where the
   * generate dialog didn't explicitly attribute one).
   */
  scheduleSourceModelId: string | null;
}

export interface ExportResultLike {
  content: string | Uint8Array;
}

/**
 * Splice the pending schedule into the exporter's output.
 *
 * Input: the raw `result.content` from `StepExporter.export()` (which
 * may be text or bytes) + the model + the current schedule state.
 *
 * Output: the same `content` shape (string → string, Uint8Array →
 * Uint8Array) with the schedule either (a) left alone — no pending
 * schedule, or source-model doesn't match the export target, (b)
 * appended for a generated schedule, or (c) strip-and-rewritten for an
 * edited schedule.
 *
 * Gate logic:
 *   • match if `scheduleSourceModelId === modelId` (federated session)
 *   • match if `scheduleSourceModelId === null` AND we have tasks
 *     (single-model session where the generate dialog didn't attribute)
 */
export function spliceScheduleIntoExport(
  result: ExportResultLike,
  modelId: string,
  dataStore: IfcDataStore,
  state: ExportScheduleState,
): ExportResultLike {
  const taskCount = state.scheduleData?.tasks.length ?? 0;
  const sourceMatches = state.scheduleSourceModelId === modelId;
  const singleModelFallback = state.scheduleSourceModelId === null && taskCount > 0;
  const shouldInject = sourceMatches || singleModelFallback;
  if (!shouldInject) return result;

  // STEP is textual by spec but the underlying exporter sometimes
  // returns Uint8Array (pre-encoded bytes). Decode on the way in,
  // splice, re-encode on the way out so the caller's content-type
  // contract is preserved.
  const raw = result.content;
  const stepText = typeof raw === 'string'
    ? raw
    : new TextDecoder('utf-8', { fatal: false }).decode(raw);
  const injected = injectScheduleIntoStep(
    stepText,
    state.scheduleData ?? null,
    dataStore,
    { scheduleIsEdited: state.scheduleIsEdited === true },
  );
  return {
    ...result,
    content: typeof raw === 'string' ? injected : new TextEncoder().encode(injected),
  };
}
