/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Optional, portable execution context beside immutable native evidence (#6612). */
export interface AutomationReportProvenance {
  origin: 'flow';
  workflowId: string;
  runId: string;
  jobId: string;
  resultId: string;
  resource?: { name: string; fingerprint?: string };
  effectiveOptions?: Record<string, AutomationJsonValue>;
  models: Array<{ id?: string; name: string; sourceFingerprint?: string; mutationRevision?: number }>;
  timestamp: string;
  diagnostics?: Array<{ severity: 'warning' | 'error'; message: string; code?: string }>;
}
export type AutomationJsonValue = null | boolean | number | string | AutomationJsonValue[] | { [key: string]: AutomationJsonValue };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const optionalString = (value: unknown): boolean => value === undefined || identifier(value);

/** Bound the metadata traversal independently of the native report's entity rows. */
function portable(value: unknown, depth: number, budget: { left: number }): boolean {
  if (depth > 12 || --budget.left < 0) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 16384;
  if (Array.isArray(value)) return value.length <= 2048 && value.every((entry) => portable(entry, depth + 1, budget));
  return record(value) && Object.keys(value).length <= 512
    && Object.entries(value).every(([key, entry]) => key.length <= 512 && portable(entry, depth + 1, budget));
}

export function isAutomationReportProvenance(value: unknown): value is AutomationReportProvenance {
  if (!record(value) || value.origin !== 'flow' ||
    !['workflowId', 'runId', 'jobId', 'resultId'].every((key) => identifier(value[key])) ||
    typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return false;
  if (value.resource !== undefined && (!record(value.resource) || !identifier(value.resource.name) || !optionalString(value.resource.fingerprint))) return false;
  if (value.effectiveOptions !== undefined && (!record(value.effectiveOptions) || !portable(value.effectiveOptions, 0, { left: 10000 }))) return false;
  if (!Array.isArray(value.models) || value.models.length > 1000 || !value.models.every((model: unknown) => record(model)
    && identifier(model.name) && optionalString(model.id) && optionalString(model.sourceFingerprint)
    && (model.mutationRevision === undefined || (typeof model.mutationRevision === 'number' && Number.isSafeInteger(model.mutationRevision) && model.mutationRevision >= 0)))) return false;
  return value.diagnostics === undefined || (Array.isArray(value.diagnostics) && value.diagnostics.length <= 1000 && value.diagnostics.every((diagnostic: unknown) => record(diagnostic)
    && (diagnostic.severity === 'warning' || diagnostic.severity === 'error') && typeof diagnostic.message === 'string'
    && diagnostic.message.length > 0 && diagnostic.message.length <= 16384 && optionalString(diagnostic.code)));
}

/** JSON evidence equality ignores object member order; IDs and provenance remain significant. */
export function sameReportEvidence(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown, depth: number, path: WeakSet<object>): unknown => {
    if (depth > 64) throw new Error('Evidence nesting exceeds the supported depth');
    if (typeof value !== 'object' || value === null) return value;
    if (path.has(value)) throw new Error('Evidence must not contain cycles');
    path.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => normalize(entry, depth + 1, path));
      if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key], depth + 1, path)]));
      return value;
    } finally { path.delete(value); }
  };
  try { return JSON.stringify(normalize(left, 0, new WeakSet())) === JSON.stringify(normalize(right, 0, new WeakSet())); }
  catch (error) { console.warn('[Reports] Unable to compare evidence', error); return false; }
}
