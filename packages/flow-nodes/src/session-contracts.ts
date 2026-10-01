/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Portable configurations only. Files and native reports belong to the host. */
export type ModelSelector =
  | { readonly kind: 'slot'; readonly slotId: string }
  | { readonly kind: 'filename'; readonly filename: string }
  | { readonly kind: 'tagName'; readonly tagName: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function isModelSelector(v: unknown): v is ModelSelector {
  if (!isRecord(v)) return false;
  if (v.kind === 'slot') return nonempty(v.slotId);
  if (v.kind === 'filename') return nonempty(v.filename);
  if (v.kind === 'tagName') return nonempty(v.tagName);
  return false;
}

export interface SessionModel {
  readonly modelId: string;
  readonly slotId: string;
  readonly filename: string;
  readonly sourceIdentity?: string;
}
export interface SessionModels { readonly runId: string; readonly models: readonly SessionModel[] }
export interface FilenameTagRule {
  readonly operator: 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'glob';
  readonly pattern: string;
  readonly caseSensitive?: boolean;
  readonly tags: readonly string[];
}
export type ResourceSource =
  | { readonly kind: 'embedded'; readonly value: unknown; readonly name?: string }
  | { readonly kind: 'slot'; readonly slotId: string; readonly filename?: string };
export interface CheckJob {
  readonly id: string;
  readonly enabled: boolean;
  readonly source: ResourceSource;
  readonly targets?: readonly ModelSelector[];
  readonly tagBindings?: Readonly<Record<string, string>>;
}
export interface DocumentMapping {
  readonly blockId: string;
  readonly jobId: string;
  readonly resultId?: string;
}

/** Each service checks grants and run ownership again at the host boundary. */
export interface SessionAutomationHost {
  loadModels(files: unknown, selectors: unknown, signal?: AbortSignal): Promise<SessionModels>;
  assignTags(models: unknown, rules: unknown, signal?: AbortSignal): Promise<SessionModels>;
  validate(models: unknown, jobs: unknown, files: unknown, signal?: AbortSignal): Promise<string>;
  compare(models: unknown, jobs: unknown, files: unknown, signal?: AbortSignal): Promise<string>;
  importComparisons(files: unknown, signal?: AbortSignal): Promise<string>;
  buildDocument(validation: unknown, comparisons: unknown, historical: unknown, config: unknown, signal?: AbortSignal): Promise<string>;
  exportPdf(document: unknown, signal?: AbortSignal): Promise<string>;
}

export const AUTOMATION_FEATURES = ['sessionModels', 'modelTags', 'validationChecks',
  'comparisonChecks', 'comparisonReports', 'reportDocuments', 'pdfArtifacts'] as const;

export function parseTagRules(value: unknown): readonly FilenameTagRule[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Tag rules must be an array of at most 100 entries');
  return value.map((r: unknown) => {
    if (!isRecord(r) || typeof r.operator !== 'string' || !['equals', 'contains', 'startsWith', 'endsWith', 'glob'].includes(r.operator)
      || !nonempty(r.pattern) || r.pattern.length > 1000 || !Array.isArray(r.tags)
      || r.tags.length === 0 || !r.tags.every(nonempty)
      || (r.caseSensitive !== undefined && typeof r.caseSensitive !== 'boolean')) throw new Error('Invalid filename tag rule');
    return r as unknown as FilenameTagRule;
  });
}

export function parseCheckJobs(value: unknown): readonly CheckJob[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Checks must be an array of at most 100 jobs');
  const ids = new Set<string>();
  return value.map((j: unknown) => {
    if (!isRecord(j) || !nonempty(j.id) || ids.has(j.id) || typeof j.enabled !== 'boolean'
      || !isRecord(j.source)) throw new Error('Each check needs a unique ID, enabled flag and source');
    const s = j.source;
    if (!(s.kind === 'embedded' && 'value' in s) && !(s.kind === 'slot' && nonempty(s.slotId))) throw new Error(`Invalid source for ${j.id}`);
    if (s.kind === 'embedded' && s.name !== undefined && !nonempty(s.name)) throw new Error(`Invalid name for ${j.id}`);
    if (s.filename !== undefined && !nonempty(s.filename)) throw new Error(`Invalid filename for ${j.id}`);
    if (j.targets !== undefined && (!Array.isArray(j.targets) || !j.targets.every(isModelSelector))) throw new Error(`Invalid targets for ${j.id}`);
    if (j.tagBindings !== undefined && (!isRecord(j.tagBindings) || !Object.values(j.tagBindings).every(nonempty))) throw new Error(`Invalid tag bindings for ${j.id}`);
    ids.add(j.id);
    return j as unknown as CheckJob;
  });
}

/** Linear wildcard matcher with bounded input, avoiding attacker-supplied regex. */
export function matchesFilename(filename: string, rule: FilenameTagRule): boolean {
  const value = rule.caseSensitive ? filename : filename.toLowerCase();
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
  switch (rule.operator) {
    case 'equals': return value === pattern;
    case 'contains': return value.includes(pattern);
    case 'startsWith': return value.startsWith(pattern);
    case 'endsWith': return value.endsWith(pattern);
    case 'glob': {
      let i = 0, p = 0, star = -1, retry = 0;
      while (i < value.length) {
        if (pattern[p] === '?' || pattern[p] === value[i]) { i++; p++; }
        else if (pattern[p] === '*') { star = p++; retry = i; }
        else if (star >= 0) { p = star + 1; i = ++retry; }
        else return false;
      }
      while (pattern[p] === '*') p++;
      return p === pattern.length;
    }
  }
}
