/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The native evidence adapter contract (#6833, P01/P03). One adapter per
 * assistant source turns native store state into a bounded, frozen snapshot:
 *
 * - `readiness` is what the source picker shows live. It must be O(1)-ish:
 *   sizes and lengths, never a population walk.
 * - `identity` names the native result the snapshot was taken from. It is
 *   compared by reference (arrays element by element) on every store change
 *   while a question is in flight, so it must be cheap and must change when
 *   the native result is replaced.
 * - `reportStamp` is the run-time analysis stamp of a stored result
 *   (`stampAnalysisReport`), so a result that predates an edit is stale even
 *   if it is captured afterwards. Live sources recomputed on every edit omit it.
 * - `capture` returns native totals in `summary` (never recomputed from the
 *   sample), at most `limit` rows, the exact native `totalRows` and whether a
 *   native result existed at all. An available result with zero rows is
 *   "empty"; an unavailable one never means a completed check without findings.
 *
 * New adapters start every row with the common envelope (`evidenceRow`):
 * `kind`, and where the native source supplies them `modelId`, `globalId`,
 * `expressId`, `unit` and `status`. Unknown provenance stays absent or
 * explicitly `null`; it is never guessed. The five original adapters keep
 * their established row shapes, which saved conversations already contain.
 */

import type { TranslatableMessage, TranslationKey } from '@/i18n';
import type { ViewerState } from '@/store';
import type { AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import type { AssistantSource } from '../sources';

export type AdapterGroup = 'checks' | 'coordination' | 'quantities' | 'model' | 'automation';

export interface AdapterReadiness {
  status: TranslatableMessage;
  /** A native result exists and can be attached now. */
  ready: boolean;
  /** The picker can run the native producer in place (clash only today). */
  runnable?: boolean;
  running?: boolean;
}

export type CaptureAvailability = 'available' | 'unavailable';

export interface AdapterCapture {
  summary: unknown;
  /** At most the requested limit; each item becomes one cited row. */
  rows: unknown[];
  /** Exact native population, independent of the included rows. */
  totalRows: number;
  availability: CaptureAvailability;
}

export interface EvidenceAdapter {
  id: AssistantSource;
  group: AdapterGroup;
  /** Panels whose header offers Discuss with AI for this source; the first is where Open goes. */
  panelIds: readonly WorkspacePanelId[];
  /** When several adapters share a panel: whether this one is the panel's current subject. */
  panelSubject?: (state: ViewerState) => boolean;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  rowMeaningKey: TranslationKey;
  unavailableKey: TranslationKey;
  suggestionKeys: readonly TranslationKey[];
  readiness: (state: ViewerState) => AdapterReadiness;
  identity: (state: ViewerState) => unknown;
  reportStamp?: (state: ViewerState) => AnalysisStamp | null;
  capture: (state: ViewerState, limit: number) => AdapterCapture;
}

/** Common row envelope for new adapters; source fields follow it. */
export interface EvidenceRowEnvelope {
  kind: string;
  modelId?: string | null;
  globalId?: string | null;
  expressId?: number | null;
  unit?: string | null;
  status?: string | null;
}

export function evidenceRow<T extends object>(envelope: EvidenceRowEnvelope, fields: T): EvidenceRowEnvelope & T {
  return { ...envelope, ...fields };
}

/** First `limit` items of an iterable without materialising the rest. */
export function take<T>(items: Iterable<T>, limit: number): T[] {
  const out: T[] = [];
  if (limit <= 0) return out;
  for (const item of items) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** Reference identity, element-wise for composite (array) identities. */
export function sameIdentity(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

export const unavailableCapture = (summary: unknown = null): AdapterCapture =>
  ({ summary, rows: [], totalRows: 0, availability: 'unavailable' });
